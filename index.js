// 雀乐 source for MyGo Music. Every exported function follows the one-object
// parameter convention used by MyGo Music plugins.

const API_BASE = "https://api.indie.cn";
const WEB_API_BASE = "https://www.indie.cn/queyueapi";
const NETEASE_BASE = "https://music.163.com";
const LRCLIB_BASE = "https://lrclib.net";
const USER_AGENT = "cn.luoo.indiemusic";
const LRCLIB_USER_AGENT =
  "MyGoMusic-QueYue/0.1.0 (https://github.com/popeyelau/mygo-queyue)";
const NETEASE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const NETEASE_COOKIE = "os=pc; appver=8.9.70";

const PAGE_SIZE = 10;
const JOURNAL_PAGE_SIZE = 50;
const FM_BATCH_SIZE = 30;
const TOKEN_KEY = "authorization";
const ACCOUNT_KEY = "account";
const t = (text) => (typeof host.t === "function" ? host.t(text) : text);
const FM_STATIONS = [
  ["自由畅听", "探索无限可能"],
  ["黑暗低语", "深渊也有星光"],
  ["心灵之舞", "闭上眼睛，听风跳舞"],
  ["暮色余晖", "孤独是温柔的弦"],
  ["不羁之音", "灵魂在破音处自由"],
].map(([name, description], id) => ({
  id: String(id),
  name,
  description,
  imageUrl: `https://cdn.jsdelivr.net/gh/popeyelau/mygo-queyue@main/assets/topic-${id}.png`,
}));

const trackCache = new Map();
const journalCache = new Map();
const lyricCache = new Map();
let dailyTracksCache = [];

function fail(code, message) {
  const error = new Error(message || t("Request failed"));
  error.code = code;
  return error;
}

function clearSession() {
  host.storage.remove(TOKEN_KEY);
  host.storage.remove(ACCOUNT_KEY);
}

function tokenNow() {
  const token = host.storage.get(TOKEN_KEY);
  return typeof token === "string" ? token : "";
}

function requireToken() {
  const token = tokenNow();
  if (!token) throw fail("signIn", t("Please sign in"));
  return token;
}

function queryString(values = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    );
  }
  return parts.join("&");
}

async function rawRequest(path, options = {}) {
  const {
    base = API_BASE,
    method = "GET",
    query,
    form,
    auth = false,
    token,
  } = options;
  const encodedQuery = queryString(query);
  const url = `${base}${path}${encodedQuery ? `?${encodedQuery}` : ""}`;
  const headers = { "User-Agent": USER_AGENT };
  const authorization = token || (auth ? requireToken() : tokenNow());
  if (authorization) headers.Authorization = authorization;

  const init = { method, headers };
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    init.body = queryString(form);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`${t("Connection failed")}: ${error?.message || error}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearSession();
      throw fail("signIn", t("Session expired. Please sign in again."));
    }
    throw new Error(`${t("Request failed")} (HTTP ${response.status})`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(t("Invalid response"));
  }
}

async function api(path, options = {}) {
  const payload = await rawRequest(path, options);
  if (payload?.code === 200) return payload.data;

  if (
    payload?.code === 401 ||
    payload?.code === 403 ||
    (options.auth && payload?.code === 10000)
  ) {
    clearSession();
    throw fail(
      "signIn",
      payload?.message || t("Session expired. Please sign in again."),
    );
  }
  throw new Error(
    payload?.message ||
      `${t("Request failed")} (${payload?.code ?? t("Unknown error")})`,
  );
}

async function neteaseAPI(path, query = {}) {
  const encodedQuery = queryString(query);
  const response = await fetch(
    `${NETEASE_BASE}${path}${encodedQuery ? `?${encodedQuery}` : ""}`,
    {
      headers: {
        "User-Agent": NETEASE_USER_AGENT,
        Referer: `${NETEASE_BASE}/`,
        Origin: NETEASE_BASE,
        Cookie: NETEASE_COOKIE,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`${t("Lyrics request failed")} (HTTP ${response.status})`);
  }
  const payload = await response.json();
  if (payload?.code !== undefined && payload.code !== 200) {
    throw new Error(
      payload.message ||
        payload.msg ||
        `${t("Lyrics API returned")} ${payload.code}`,
    );
  }
  return payload;
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchAccount(token = requireToken()) {
  const user = await api("/user/my/userInfo", { auth: true, token });
  const current = {
    id: String(user.id),
    name: user.nickName || t("Listener"),
    imageUrl: user.avatar || "",
  };
  host.storage.set(ACCOUNT_KEY, current);
  return current;
}

async function currentAccount() {
  const stored = host.storage.get(ACCOUNT_KEY);
  if (stored?.id) return stored;
  return fetchAccount();
}

export async function signIn() {
  const uuid = await api("/user/user/uuid", { base: WEB_API_BASE });
  if (!uuid) throw new Error(t("Could not get QR code"));

  const qr = `https://m.indie.cn/?code=${encodeURIComponent(uuid)}`;
  host.signInPrompt({ qr, text: t("Scan with the app to sign in") });
  let scanned = false;

  // Leave a little room before MyGo Music's five-minute sign-in timeout.
  for (let attempt = 0; attempt < 140; attempt += 1) {
    const payload = await rawRequest("/user/user/check/qr", {
      base: WEB_API_BASE,
      query: { uuid },
    });

    if (payload?.code === 200 && typeof payload.data === "string") {
      if (payload.data.startsWith("Bearer ")) {
        host.storage.set(TOKEN_KEY, payload.data);
        try {
          const signedIn = await fetchAccount(payload.data);
          host.signInPrompt({ text: `${t("Signed in")}: ${signedIn.name}` });
          return signedIn;
        } catch (error) {
          clearSession();
          throw error;
        }
      }
      if (payload.data === "1" && !scanned) {
        scanned = true;
        host.signInPrompt({
          qr,
          text: t("QR code scanned. Confirm sign-in on your phone."),
        });
      }
    } else if (payload?.code !== 10000) {
      throw new Error(
        payload?.message || t("Could not check the QR code status"),
      );
    }

    if (attempt < 139) await sleep(2000);
  }
  throw new Error(t("The QR code has expired. Please sign in again."));
}

export function signOut() {
  clearSession();
}

export async function account() {
  if (!tokenNow()) return null;
  const stored = host.storage.get(ACCOUNT_KEY) ?? null;
  try {
    return await fetchAccount();
  } catch (error) {
    if (error?.code === "signIn") return null;
    if (stored?.id) return stored;
    throw error;
  }
}

function durationMilliseconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const pieces = value.split(":").map(Number);
  if (pieces.length < 2 || pieces.some((piece) => !Number.isFinite(piece)))
    return 0;
  return pieces.reduce((seconds, piece) => seconds * 60 + piece, 0) * 1000;
}

function trackToMusic(track) {
  const id = String(track.id);
  trackCache.set(id, track);
  const artistName = track.artist || t("Unknown artist");
  const albumName =
    track.album || `VOL.${String(track.journalNo || "").padStart(4, "0")}`;
  return {
    id,
    name: track.title || t("Untitled track"),
    artists: [{ id: `artist:${artistName}`, name: artistName }],
    album: {
      id: `journal:${track.journalNo || "unknown"}:${albumName}`,
      name: albumName,
      imageUrl: track.pic || "",
    },
    duration: durationMilliseconds(track.duration),
    unavailable: !track.src,
  };
}

function journalToPlaylist(journal, tracks) {
  const id = String(journal.id);
  journalCache.set(id, journal);
  const playlist = {
    id,
    name: `VOL.${journal.journalNo} ${journal.title}`,
    imageUrl: journal.image || "",
    description: journal.summary || "",
    owner: journal.editor || t("QueYue"),
    saved: Boolean(journal.haveCollect),
    trackCount: journal.songCount || 0,
  };
  if (tracks) {
    playlist.tracks = tracks.map(trackToMusic);
    playlist.trackCount = playlist.tracks.length;
  }
  return playlist;
}

function paged(data) {
  return {
    total: Number(data?.total) || 0,
    rows: Array.isArray(data?.rows) ? data.rows : [],
  };
}

function hasMorePage(result, pageNumber) {
  return (
    pageNumber * PAGE_SIZE < result.total ||
    (result.total === 0 && result.rows.length === PAGE_SIZE)
  );
}

async function dailySongs(refresh = false) {
  if (!refresh && dailyTracksCache.length) return dailyTracksCache;
  const tracks = await api("/luoo-music/song/random/30");
  dailyTracksCache = (tracks || []).map(trackToMusic);
  return dailyTracksCache;
}

export async function home() {
  const [daily, recommended] = await Promise.all([
    dailySongs(true),
    api("/luoo-music/journal/recommend"),
  ]);
  return {
    title: t("QueYue"),
    sections: [
      {
        title: t("Daily Picks"),
        tracks: daily,
        morePage: "daily",
        pageTitle: t("Daily Picks"),
        subtitle: t("Songs picked for you today"),
      },
      {
        title: t("Recommended Journals"),
        playlists: (recommended || []).map((journal) =>
          journalToPlaylist(journal),
        ),
        morePage: "journals",
      },
      {
        title: t("Stations"),
        stations: stations(),
      },
    ],
  };
}

async function journalsLandingPage() {
  const latestData = await api("/luoo-music/journal/list", {
    query: { pageNum: 1, pageSize: JOURNAL_PAGE_SIZE },
  });
  const latest = paged(latestData);
  return {
    title: t("Journals"),
    sections: [
      {
        title: "",
        playlists: latest.rows.map((journal) => journalToPlaylist(journal)),
        empty: t("No journals yet"),
      },
    ],
  };
}

export async function playlists() {
  const listener = await currentAccount();
  const result = paged(
    await api("/luoo-music/journal/collect", {
      auth: true,
      query: { userId: listener.id },
    }),
  );
  return result.rows.map((journal) =>
    journalToPlaylist({ ...journal, haveCollect: true }),
  );
}

export async function browse({ page }) {
  if (page === "daily") {
    return {
      title: t("Daily Picks"),
      subtitle: t("Songs picked for you today"),
      sections: [{ tracks: await dailySongs() }],
    };
  }
  if (page === "journals") return journalsLandingPage();
  throw fail("unavailable", t("This page does not exist"));
}

export async function playlist({ id }) {
  const journal =
    journalCache.get(String(id)) ||
    (await api(`/luoo-music/journal/${encodeURIComponent(id)}`));
  if (!journal?.journalNo)
    throw fail("unavailable", t("This journal could not be found"));
  const tracks = await api(
    `/luoo-music/song/getByJournalNo/${encodeURIComponent(journal.journalNo)}`,
  );
  return journalToPlaylist(journal, tracks || []);
}

export async function search({ query, kind, offset = 0 }) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery || (kind !== "tracks" && kind !== "playlists")) {
    return { [kind]: [], more: false };
  }
  const pageNumber =
    Math.floor(Math.max(0, Number(offset) || 0) / PAGE_SIZE) + 1;
  const result = paged(
    await api(`/luoo-music/search/fuzzy/${kind === "tracks" ? "song" : "journal"}`, {
      query: {
        keyword: cleanQuery,
        pageNum: pageNumber,
        pageSize: PAGE_SIZE,
      },
    }),
  );
  return {
    [kind]: result.rows.map((item) =>
      kind === "tracks" ? trackToMusic(item) : journalToPlaylist(item),
    ),
    more: hasMorePage(result, pageNumber),
  };
}

export async function suggest({ query }) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return [];
  return (
    (await api("/luoo-music/search/autoComplete", {
      query: { query: cleanQuery, limit: 10 },
    })) || []
  );
}

export function stations() {
  return FM_STATIONS.map((station) => ({ ...station }));
}

export async function stationNext({ id }) {
  const tracks = await api("/luoo-music/song/random", {
    query: { limit: FM_BATCH_SIZE, topicId: id },
  });
  return (tracks || []).map(trackToMusic);
}

export async function liked({ offset = 0 }) {
  const listener = await currentAccount();
  const pageNumber =
    Math.floor(Math.max(0, Number(offset) || 0) / PAGE_SIZE) + 1;
  const result = paged(
    await api("/luoo-music/song/collect", {
      auth: true,
      query: { userId: listener.id, pageNum: pageNumber, pageSize: PAGE_SIZE },
    }),
  );
  return {
    tracks: result.rows.map((track) =>
      trackToMusic({ ...track, haveCollect: true }),
    ),
    more: hasMorePage(result, pageNumber),
  };
}

export function isLiked({ ids }) {
  return Object.fromEntries(
    (ids || []).map((id) => {
      const track = trackCache.get(String(id));
      return [String(id), Boolean(track?.haveCollect)];
    }),
  );
}

async function setCollected(objectId, collectType, on) {
  await api("/user/collect", {
    auth: true,
    method: on ? "POST" : "DELETE",
    [on ? "form" : "query"]: { objectId, collectType },
  });
}

export async function like({ id, on }) {
  await setCollected(id, 0, on);
  const cached = trackCache.get(String(id));
  if (cached) cached.haveCollect = Boolean(on);
}

export async function savePlaylist({ id, on }) {
  await setCollected(id, 1, on);
  const cached = journalCache.get(String(id));
  if (cached) cached.haveCollect = Boolean(on);
}

async function rawTrack(id) {
  const key = String(id);
  if (trackCache.has(key)) return trackCache.get(key);
  const track = await api(`/luoo-music/song/${encodeURIComponent(key)}`);
  if (!track) throw fail("unavailable", t("This track could not be found"));
  trackCache.set(key, track);
  return track;
}

function audioType(url) {
  const match = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(url || "");
  const type = (match?.[1] || "mp3").toLowerCase();
  return ["mp3", "flac", "ogg", "wav", "m4a", "aac"].includes(type)
    ? type
    : "mp3";
}

export async function stream({ id }) {
  const track = await rawTrack(id);
  if (!track.src)
    throw fail("unavailable", t("This track is currently unavailable"));
  return {
    url: track.src,
    type: audioType(track.src),
    quality: "standard",
  };
}

function normLyricText(text) {
  if (!text) return "";
  return String(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function stripTitleNoise(title) {
  return String(title || "")
    .replace(
      /\s*[([](?:feat\.?|featuring|with|remaster\w*|\d{4}\s+remaster\w*|live|deluxe|version|ver\.|bonus|from\s+|唱片版|remix).*?[)\]]/gi,
      "",
    )
    .replace(
      /\s*-\s*(?:\d{4}\s+)?(?:remaster\w*|live|deluxe|mono|single|version|ver\.|from\s+).*$/gi,
      "",
    )
    .trim();
}

function isCoverOrInstrumental(candidateTitle, targetTitle) {
  const unwanted = /(?:cover|翻唱|伴奏|纯音乐|piano|钢琴|instrumental|karaoke)/i;
  return unwanted.test(candidateTitle) && !unwanted.test(targetTitle);
}

function scoreLyricCandidate(candidate, target) {
  const difference = Math.abs(candidate.durationSec - target.durationSec);
  if (difference > 3) return null;
  if (isCoverOrInstrumental(candidate.title, target.name)) return null;

  const targetTitle = normLyricText(target.name);
  const cleanTargetTitle = normLyricText(stripTitleNoise(target.name));
  const candidateTitle = normLyricText(candidate.title);
  const cleanCandidateTitle = normLyricText(
    stripTitleNoise(candidate.title),
  );

  let titleScore = 0;
  if (candidateTitle && candidateTitle === targetTitle) {
    titleScore = 60;
  } else if (
    cleanCandidateTitle &&
    cleanTargetTitle &&
    cleanCandidateTitle === cleanTargetTitle
  ) {
    titleScore = 55;
  } else if (
    cleanCandidateTitle &&
    cleanTargetTitle &&
    (cleanCandidateTitle.includes(cleanTargetTitle) ||
      cleanTargetTitle.includes(cleanCandidateTitle))
  ) {
    titleScore = 35;
  }
  if (!titleScore) return null;

  const candidateArtist = normLyricText(candidate.author);
  const normalizedArtist = normLyricText(target.artist);
  let artistScore = 0;
  if (normalizedArtist && candidateArtist) {
    if (
      candidateArtist.includes(normalizedArtist) ||
      normalizedArtist.includes(candidateArtist)
    ) {
      artistScore = 40;
    }
    const cjkCharacters = normalizedArtist.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
    );
    if (cjkCharacters?.length) {
      const matched = cjkCharacters.filter((character) =>
        candidateArtist.includes(character),
      ).length;
      if (matched >= Math.ceil(cjkCharacters.length / 2)) {
        artistScore = 40;
      }
    }
  }

  const asciiTarget = /^[a-z0-9\s]+$/i.test(target.artist || "");
  const asciiCandidate = /^[a-z0-9\s]+$/i.test(candidate.author || "");
  if (asciiTarget && asciiCandidate && !artistScore) return null;

  const cjkTarget = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
    target.artist || "",
  );
  const cjkCandidate = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
    candidate.author || "",
  );
  if (cjkTarget && cjkCandidate && !artistScore) return null;

  const durationScore = (3 - difference) * 5;
  const syncScore = candidate.hasSync ? 20 : 0;
  return titleScore + artistScore + durationScore + syncScore;
}

function spreadPlainLyrics(text, durationMs) {
  const texts = text
    .split(/\r?\n/)
    .map((line) => line.trim());
  while (texts.length && !texts[texts.length - 1]) texts.pop();
  if (!texts.length) return { lrc: "" };
  const step = durationMs ? durationMs / texts.length : 4000;
  return {
    lines: texts.map((line, index) => ({
      start: Math.round(index * step),
      text: line,
    })),
  };
}

const hasLrcTimes = (lrc) => /^\s*\[\d+:\d+/m.test(lrc);

async function queyueLyrics(track) {
  if (!track.lrc) return "";
  const response = await fetch(track.lrc, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) return "";
  return (await response.text()).trim();
}

export async function lyrics({ id }) {
  const key = String(id);
  if (lyricCache.has(key)) return lyricCache.get(key);
  const track = await rawTrack(key);
  const durationMs = durationMilliseconds(track.duration);
  const durationSec = Math.round(durationMs / 1000);
  const target = {
    name: track.title || "",
    artist: track.artist || "",
    album: track.album || "",
    durationSec,
  };
  const combined = `${target.name} ${target.artist}`.trim();
  const queries = [combined];
  if (target.name && target.name !== combined) queries.push(target.name);
  let plain = "";

  // 1. LRCLIB exact match.
  try {
    const query = queryString({
      track_name: target.name,
      artist_name: target.artist,
      album_name: target.album,
      duration: durationSec || undefined,
    });
    const response = await fetch(`${LRCLIB_BASE}/api/get?${query}`, {
      headers: { "User-Agent": LRCLIB_USER_AGENT },
    });
    if (response.ok) {
      const record = await response.json();
      if (record.syncedLyrics?.trim()) {
        const result = { lrc: record.syncedLyrics.trim() };
        lyricCache.set(key, result);
        return result;
      }
      plain ||= record.plainLyrics?.trim() || "";
    }
  } catch (error) {
    console.warn(`LRCLIB exact lyrics failed: ${error?.message || error}`);
  }

  // 2. LRCLIB search, first with title and artist, then title only.
  try {
    for (const query of queries) {
      const response = await fetch(
        `${LRCLIB_BASE}/api/search?q=${encodeURIComponent(query)}`,
        { headers: { "User-Agent": LRCLIB_USER_AGENT } },
      );
      if (!response.ok) continue;
      const records = await response.json();
      if (!Array.isArray(records)) continue;
      const scored = [];
      for (const record of records.slice(0, 10)) {
        const synced = record.syncedLyrics?.trim();
        const lyric = synced || record.plainLyrics?.trim();
        if (!lyric) continue;
        const candidate = {
          title: record.trackName || record.name || "",
          author: record.artistName || "",
          durationSec: Math.round(Number(record.duration) || 0),
          hasSync: Boolean(synced),
          lyric,
        };
        const score = scoreLyricCandidate(candidate, target);
        if (score !== null) scored.push({ candidate, score });
      }
      scored.sort((left, right) => right.score - left.score);
      const synced = scored.find((item) => item.candidate.hasSync);
      if (synced) {
        const result = { lrc: synced.candidate.lyric };
        lyricCache.set(key, result);
        return result;
      }
      plain ||= scored[0]?.candidate.lyric || "";
    }
  } catch (error) {
    console.warn(`LRCLIB search failed: ${error?.message || error}`);
  }

  // 3. NetEase Cloud Music.
  try {
    for (const query of queries) {
      const search = await neteaseAPI("/api/cloudsearch/pc", {
        s: query,
        type: 1,
        limit: 10,
      });
      const scored = [];
      for (const song of (search?.result?.songs || []).slice(0, 10)) {
        const candidate = {
          id: song.id,
          title: song.name || "",
          author: (song.ar || [])
            .map((artist) => artist?.name)
            .filter(Boolean)
            .join(" / "),
          durationSec: Math.round((Number(song.dt) || 0) / 1000),
          hasSync: true,
        };
        const score = scoreLyricCandidate(candidate, target);
        if (score !== null) scored.push({ candidate, score });
      }
      scored.sort((left, right) => right.score - left.score);
      for (const item of scored) {
        const response = await neteaseAPI("/api/song/lyric", {
          id: item.candidate.id,
          lv: 1,
          tv: -1,
        });
        const lyric = response?.lrc?.lyric;
        if (typeof lyric !== "string") continue;
        const cleaned = lyric.trim();
        if (!cleaned || cleaned.includes("纯音乐，请欣赏")) continue;
        if (hasLrcTimes(cleaned)) {
          const result = {
            lrc: cleaned,
            translation: response?.tlyric?.lyric?.trim() || undefined,
          };
          lyricCache.set(key, result);
          return result;
        }
        plain ||= cleaned;
      }
      if (scored.length) break;
    }
  } catch (error) {
    console.warn(`NetEase lyrics failed: ${error?.message || error}`);
  }

  // Preserve QueYue's own lyric file as a final non-search fallback.
  try {
    const local = await queyueLyrics(track);
    if (local) {
      if (hasLrcTimes(local)) {
        const result = { lrc: local };
        lyricCache.set(key, result);
        return result;
      }
      plain ||= local;
    }
  } catch (error) {
    console.warn(`QueYue lyrics failed: ${error?.message || error}`);
  }

  const result = plain
    ? spreadPlainLyrics(plain, durationMs)
    : { lrc: "" };
  lyricCache.set(key, result);
  return result;
}
