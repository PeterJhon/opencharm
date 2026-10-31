// The settings window: every change is saved and applied at once (the key is live, the app's own
// charmd restarts for a new folder, agent or voice, the charm reconnects, start-at-login follows).
// The charm at the top is the real face engine, reacting.
import { colourOf, mountColourPicker } from "./colour-picker.js";
import { MICROSOFT_DEFAULTS, MICROSOFT_VOICES } from "./microsoft-voices.js";
import { describeModels } from "./voice-progress.js";

const { invoke } = window.__TAURI__.core;

const mac = navigator.platform.toLowerCase().includes("mac");
const KEYS = mac
  ? [
      ["alt+space", "⌥ Option + Space"],
      ["ctrl+space", "⌃ Control + Space"],
      ["ctrl+alt+space", "⌃ ⌥ Control + Option + Space"],
      ["super+shift+space", "⌘ ⇧ Command + Shift + Space"],
    ]
  : [
      ["ctrl+alt+space", "Ctrl + Alt + Space"],
      ["ctrl+shift+space", "Ctrl + Shift + Space"],
      ["alt+shift+space", "Alt + Shift + Space"],
    ];

const TYPE_KEYS = mac
  ? [
      ["alt+shift+space", "⌥ ⇧ Option + Shift + Space"],
      ["ctrl+shift+space", "⌃ ⇧ Control + Shift + Space"],
      ["ctrl+alt+shift+space", "⌃ ⌥ ⇧ Control + Option + Shift + Space"],
    ]
  : [
      ["ctrl+alt+shift+space", "Ctrl + Alt + Shift + Space"],
      ["alt+shift+space", "Alt + Shift + Space"],
    ];

const $ = (id) => document.getElementById(id);
const status = $("status");
const charm = window.CharmFace.device($("face"), {
  shape: "icon",
  face: "happy",
  colour: window.CharmFace.COLORS[0],
});
const react = (face, ms = 1400) => {
  charm.face.set({ face });
  clearTimeout(react.timer);
  react.timer = setTimeout(() => charm.face.set({ face: "happy" }), ms);
};

const AGENTS = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["gemini", "Gemini CLI"],
  ["goose", "goose"],
  ["hermes", "Hermes"],
  ["openclaw", "OpenClaw"],
  ["command", "其他 ACP 智能体（命令）"],
  ["server", "服务器（OpenAI 兼容）"],
];
const STATES = {
  running: ["running", "正在与 charmd 通信。按住按键说话。"],
  starting: ["starting", "正在启动 charmd…"],
  restarting: ["needs", "charmd 已停止，正在重新启动。"],
  folder: ["needs", ""],
  missing: ["needs", ""],
  off: ["", "正在使用另一个 charmd（高级）。"],
};

let settings = await invoke("get_settings");
// What this build is, for bug reports (spec 015).
$("identity").textContent = (await invoke("app_identity")).text;
let folder = null;
for (const [value, label] of KEYS) $("key").append(new Option(label, value));
for (const [value, label] of TYPE_KEYS)
  $("type-key").append(new Option(label, value));
if (!TYPE_KEYS.some(([value]) => value === settings.typeKey))
  $("type-key").append(new Option(settings.typeKey, settings.typeKey));
if (!KEYS.some(([value]) => value === settings.key))
  $("key").append(new Option(settings.key, settings.key));

const home = (path) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

function fill() {
  $("key").value = settings.key;
  $("type-key").value = settings.typeKey;
  $("url").value = settings.url;
  $("login").checked = settings.startAtLogin;
  $("network").checked = settings.network;
  $("speak-replies").checked = settings.speakReplies;
  $("updates").checked = settings.checkUpdates;
  $("external").checked = !settings.managed;
  $("url-section").hidden = settings.managed;
  document.querySelector(".managed").hidden = !settings.managed;
  $("restart").hidden = !settings.managed;
  $("folder").value = settings.folder ? home(settings.folder) : "";
  $("cli").value = settings.cliPath ?? "";
  $("command").value = settings.agentCommand;
  $("server-url").value = settings.serverUrl;
  $("server-model").value = settings.serverModel;
  $("listen").value = settings.listen;
  $("speak").value = settings.speak;
  $("language").value = settings.language;
  // `say` is macOS only.
  $("speak").querySelector('[value="system"]').hidden = !mac;

  // A workspace may keep its own agent ("as the workspace says"); any other folder picks one.
  $("agent").replaceChildren();
  if (folder?.isWorkspace) $("agent").append(new Option("按工作区设置", ""));
  for (const [value, label] of AGENTS)
    $("agent").append(new Option(label, value));
  $("agent").value = settings.agent || (folder?.isWorkspace ? "" : "claude");
  $("command-row").hidden = settings.agent !== "command";
  $("server-row").hidden = settings.agent !== "server";
  $("key-row").hidden =
    settings.listen !== "openai" && settings.speak !== "openai";
  $("elevenlabs-row").hidden =
    settings.listen !== "elevenlabs" && settings.speak !== "elevenlabs";
  $("elevenlabs-voice-row").hidden = settings.speak !== "elevenlabs";
  $("elevenlabs-model").value = settings.elevenlabsModel ?? "";
  fillElevenLabsVoices();
  $("listen-note").textContent = {
    local: "在这台电脑上识别：你的声音不会离开它。首次启动会下载约 490 MB。",
    openai: "OpenAI 会听到你说的话。密钥保存在钥匙串中。",
    elevenlabs: "ElevenLabs 会听到你说的话。密钥保存在钥匙串中。",
    fake: "不使用麦克风：挂件会听到一句测试话。仅供试用。",
  }[settings.listen];
  $("speak-note").textContent = {
    microsoft:
      "自然的声音，免费且无需密钥。每条朗读回复的文字会通过一个非官方服务发送给微软，该服务可能停止；届时会用这台电脑上的声音朗读。",
    local:
      "使用这台电脑上的声音：什么都不离开它，但听起来没那么自然（首次约 130 MB）。",
    system: "使用下方来自 macOS 的声音。什么都不离开这台 Mac。",
    openai: "OpenAI 的声音。密钥保存在钥匙串中。",
    elevenlabs:
      "ElevenLabs 的声音：每条朗读回复的文字会发送给 ElevenLabs。密钥保存在钥匙串中。",
    fake: "不使用扬声器：用一声轻音代替说话。仅供试用。",
  }[settings.speak];

  fillMicrosoftVoice();

  const note = $("folder-note");
  $("create").hidden = !(folder?.exists && folder.empty);
  if (!folder) {
    note.textContent =
      "OpenCharm 工作区（例如 Momo），或任何你想让智能体工作的文件夹。";
  } else if (folder.refused) {
    note.textContent =
      "macOS 不允许 OpenCharm 打开那个文件夹。请在 系统设置 → 隐私与安全性 → 文件和文件夹 中允许它，或选择另一个。";
  } else if (!folder.exists) {
    note.textContent = "那个文件夹不见了。请选择另一个。";
  } else if (folder.isWorkspace) {
    note.textContent = `OpenCharm 工作区：${folder.name}，按其 opencharm.json 的设置。`;
  } else if (folder.empty) {
    note.textContent =
      "空文件夹。在这里创建工作区（起始模板的副本），或选择另一个。";
  } else {
    note.textContent = "你的智能体就在这个文件夹里工作，保持原样。";
  }
}

async function look(path) {
  folder = path ? await invoke("inspect_folder", { path }) : null;
}

// The voices in your ElevenLabs account, asked from the app's charmd (it holds the key); asked again
// when charmd restarts with ElevenLabs, so a key saved just now shows them.
let elevenLabsVoices = [];
let elevenLabsAsked = false;
async function loadElevenLabsVoices(charmdState) {
  // Asked once per start of charmd that speaks with ElevenLabs.
  if (settings.speak !== "elevenlabs" || charmdState !== "running") {
    elevenLabsAsked = false;
    return;
  }
  if (elevenLabsAsked) return;
  elevenLabsAsked = true;
  try {
    elevenLabsVoices = await invoke("elevenlabs_voices");
    $("elevenlabs-voice-note").textContent = elevenLabsVoices.length
      ? "你 ElevenLabs 账户中的声音。试听播放的是 ElevenLabs 自己的样本。"
      : "你的 ElevenLabs 账户还没有声音：请到 elevenlabs.io 添加。";
  } catch (error) {
    elevenLabsVoices = [];
    // Asked again on a later poll, not stuck on one failure.
    setTimeout(() => (elevenLabsAsked = false), 10_000);
    $("elevenlabs-voice-note").textContent = /401|403/.test(String(error))
      ? "ElevenLabs 拒绝了密钥：请在下面重新保存。"
      : "暂时无法获取你的 ElevenLabs 声音，稍后会重试。";
  }
  fillElevenLabsVoices();
}

function fillElevenLabsVoices() {
  const select = $("elevenlabs-voice");
  const saved = settings.elevenlabsVoice ?? "";
  select.replaceChildren(new Option("你的第一个声音", ""));
  for (const voice of elevenLabsVoices)
    select.append(
      new Option(
        voice.description ? `${voice.name} · ${voice.description}` : voice.name,
        voice.id
      )
    );
  // A voice saved earlier but not in the list stays, by its ID.
  if (saved && !elevenLabsVoices.some((v) => v.id === saved))
    select.append(new Option(saved, saved));
  select.value = saved;
}

async function save(change) {
  const next = { ...settings, ...change };
  // A change may restart charmd: its voices are asked again from the new one.
  elevenLabsAsked = false;
  status.textContent = "保存中…";
  try {
    await invoke("save_settings", { next });
    settings = next;
    status.textContent = "已保存";
    react("joy");
  } catch (error) {
    status.textContent = String(error).toUpperCase();
    react("oops", 2200);
  }
  fill();
  void poll();
  if (charmLook) await loadLook();
}

// Microsoft's voices: one per language (charmd picks the voice by the language of each reply). The
// row has its own language choice, starting at the fallback one, so setting Italian's voice doesn't
// change the language it falls back on. The default is charmd's own; choosing it drops the override.
let voiceLanguage = "";
function fillMicrosoftVoice() {
  $("ms-voice-row").hidden = settings.speak !== "microsoft";
  voiceLanguage ||= settings.language;
  $("ms-voice-lang").value = voiceLanguage;
  const select = $("ms-voice");
  const saved = settings.microsoftVoices?.[voiceLanguage];
  const fallback = MICROSOFT_DEFAULTS[voiceLanguage];
  const list = MICROSOFT_VOICES[voiceLanguage] ?? [];
  select.replaceChildren();
  // One saved by hand that isn't in the list still shows, as itself.
  if (saved && !list.some(([name]) => name === saved))
    select.append(new Option(saved, saved));
  for (const [name, label] of list)
    select.append(
      new Option(name === fallback ? `${label}（默认）` : label, name)
    );
  select.value = saved ?? fallback ?? "";
}
$("ms-voice-lang").addEventListener("change", (e) => {
  voiceLanguage = e.target.value;
  fillMicrosoftVoice();
});
$("ms-voice").addEventListener("change", (e) => {
  const voices = { ...settings.microsoftVoices };
  if (e.target.value === MICROSOFT_DEFAULTS[voiceLanguage])
    delete voices[voiceLanguage];
  else voices[voiceLanguage] = e.target.value;
  void save({ microsoftVoices: voices });
});

// The status line follows the app's own charmd.
let lastState = "";
let polling = false;
async function poll() {
  // One at a time: a slow answer never lands after a newer one.
  if (polling) return;
  polling = true;
  try {
    const s = await invoke("charmd_status");
    void loadElevenLabsVoices(s.state);
    // The first start downloads the voice models (about 600 MB): say how far it is.
    const models = s.state === "running" ? await invoke("voice_progress") : [];
    const [dot, text] = STATES[s.state] ?? ["needs", ""];
    $("dot").className = `dot ${dot}`;
    $("who").textContent =
      s.state === "off"
        ? "另一个 charmd"
        : s.name
          ? `${s.name} · ${s.agent}`
          : "还没有智能体";
    $("where").textContent =
      s.state === "off" ? settings.url : home(s.folder || "");
    const note = $("state-note");
    note.className = `note ${s.state === "running" ? "ok" : dot === "needs" ? "bad" : ""}`;
    note.textContent = [
      s.detail && s.state !== "running" ? s.detail : text,
      s.note,
      describeModels(models),
    ]
      .filter(Boolean)
      .join(" ");
    if (s.state !== lastState && lastState) {
      if (s.state === "running") react("joy", 2000);
      if (dot === "needs") react("sad", 2000);
    }
    lastState = s.state;
  } finally {
    polling = false;
  }
}

// "Your charm": its look and voice, kept in the workspace (else in the app) and applied at once.
const SLEEPS = ["2", "4", "10", "30", "0"];
let charmLook = null;
let voices = [];

function fillLook() {
  const { look, sayVoice, inWorkspace, defaultName } = charmLook;
  $("look-note").textContent = inWorkspace
    ? "保存在工作区的 opencharm.json 中，工作区里的每个挂件都一致。"
    : "保存在这个应用中。工作区会保留自己的设置。";
  $("charm-name").value = look.name;
  $("charm-name").placeholder = defaultName.slice(0, 12) || "挂件";
  const name = look.name || $("charm-name").placeholder;
  $("greeting").value = look.greeting;
  $("greeting").placeholder = `嗨！我是 ${name}。`;
  picker.set(look.colour);
  const minutes = String(look.sleepAfterMinutes);
  if (
    !SLEEPS.includes(minutes) &&
    !$("sleep").querySelector(`[value="${minutes}"]`)
  )
    $("sleep").append(new Option(`独处 ${minutes} 分钟后`, minutes));
  $("sleep").value = minutes;
  $("volume").value = String(look.volume);
  $("volume-value").textContent = `${look.volume}%`;
  $("calm").checked = look.motion === "calm";
  $("agent-look").checked = look.agentCanChangeLook;
  $("say-section").hidden = settings.speak !== "system" || voices.length === 0;
  $("say-voice").value = sayVoice;
  charm.setColour(colourOf(look.colour));
}

async function loadLook() {
  charmLook = await invoke("get_look");
  fillLook();
}

async function saveLook(change, voice) {
  const look = { ...charmLook.look, ...change };
  const sayVoice = voice ?? charmLook.sayVoice;
  if (new TextEncoder().encode(look.greeting).length > 40) {
    status.textContent = "问候语太长了";
    return react("oops", 2200);
  }
  status.textContent = "保存中…";
  try {
    await invoke("save_look", { look, sayVoice });
    charmLook = { ...charmLook, look, sayVoice };
    status.textContent = "已保存";
    react("joy");
  } catch (error) {
    status.textContent = String(error).toUpperCase();
    react("oops", 2200);
  }
  fillLook();
}

const picker = mountColourPicker($("colours"), {
  labelledBy: "colour-label",
  onPick: (colour) => saveLook({ colour }),
  onPreview: (colour) => charm.setColour(colour),
  onError: (text) => {
    status.textContent = text.toUpperCase();
    react("oops", 2200);
  },
});

// The voices that speak the system's language first, then the rest.
voices = await invoke("list_voices");
const language = navigator.language.split("-")[0].toLowerCase();
const mine = voices.filter((v) => v.locale.split("_")[0] === language);
const others = voices.filter((v) => v.locale.split("_")[0] !== language);
// Empty means charmd's default, Samantha: English, whatever the system language.
$("say-voice").append(new Option("Samantha · English（默认）", ""));
for (const [label, list] of [
  ["你的语言", mine],
  ["其他语言", others],
]) {
  if (list.length === 0) continue;
  const group = document.createElement("optgroup");
  group.label = label;
  for (const v of list)
    group.append(
      new Option(`${v.name} · ${v.locale.replace("_", "-")}`, v.name)
    );
  $("say-voice").append(group);
}

$("charm-name").addEventListener(
  "change",
  (e) => void saveLook({ name: e.target.value.trim() })
);
$("greeting").addEventListener(
  "change",
  (e) => void saveLook({ greeting: e.target.value.trim() })
);
$("sleep").addEventListener(
  "change",
  (e) => void saveLook({ sleepAfterMinutes: Number(e.target.value) })
);
// The number follows the handle; the charm gets it on release, so a drag isn't a dozen saves.
$("volume").addEventListener("input", (e) => {
  $("volume-value").textContent = `${e.target.value}%`;
});
$("volume").addEventListener(
  "change",
  (e) => void saveLook({ volume: Number(e.target.value) })
);
$("calm").addEventListener(
  "change",
  (e) => void saveLook({ motion: e.target.checked ? "calm" : "full" })
);
$("agent-look").addEventListener(
  "change",
  (e) => void saveLook({ agentCanChangeLook: e.target.checked })
);
$("say-voice").addEventListener(
  "change",
  (e) => void saveLook({}, e.target.value)
);
$("try").addEventListener("click", async () => {
  const name = $("say-voice").value || "Samantha";
  const text = $("greeting").value.trim() || $("greeting").placeholder;
  try {
    await invoke("try_voice", { name, text });
    react("cute", 2400);
  } catch (error) {
    status.textContent = String(error).toUpperCase();
    react("oops", 2200);
  }
});

await look(settings.folder);
fill();
await loadLook();
await poll();
setInterval(poll, 2000);

$("key").addEventListener("change", (e) => void save({ key: e.target.value }));
$("type-key").addEventListener(
  "change",
  (e) => void save({ typeKey: e.target.value })
);
$("url").addEventListener(
  "change",
  (e) => void save({ url: e.target.value.trim() })
);
$("speak-replies").addEventListener(
  "change",
  (e) => void save({ speakReplies: e.target.checked })
);
// The menu bar's "Speak replies" changes it too.
void window.__TAURI__.event.listen("settings-changed", async () => {
  settings = await invoke("get_settings");
  fill();
});
$("network").addEventListener(
  "change",
  (e) => void save({ network: e.target.checked })
);
$("add-charm").addEventListener("click", () => void invoke("open_add_charm"));

// Your charms (spec 013): the charms paired with the app's charmd, but its own notch charm, with
// their state and battery, and Remove (a revoke: it has to pair again).
async function showCharms() {
  const list = $("charms");
  let charms = [];
  try {
    charms = await invoke("paired_charms");
  } catch {
    charms = [];
  }
  list.replaceChildren(
    ...charms.map((c) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      const b = c.battery;
      label.textContent = `${c.name} · ${c.connected ? c.state : "离线"}${
        b ? ` · ${b.percent}%${b.charging ? " 充电中" : ""}` : ""
      }`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pill ghost small";
      remove.textContent = "移除";
      // Two clicks: the app's web view answers confirm() with "no" without showing it.
      remove.addEventListener("click", async () => {
        if (remove.dataset.sure !== "1") {
          remove.dataset.sure = "1";
          remove.textContent = "移除：确定？";
          setTimeout(() => {
            remove.dataset.sure = "";
            remove.textContent = "移除";
          }, 4000);
          return;
        }
        await invoke("remove_charm", { name: c.name }).catch(() => undefined);
        await showCharms();
      });
      li.append(label, remove);
      return li;
    })
  );
}
void showCharms();
setInterval(() => {
  if (document.visibilityState === "visible") void showCharms();
}, 5000);

$("login").addEventListener(
  "change",
  (e) => void save({ startAtLogin: e.target.checked })
);
$("updates").addEventListener(
  "change",
  (e) => void save({ checkUpdates: e.target.checked })
);
$("external").addEventListener(
  "change",
  (e) => void save({ managed: !e.target.checked })
);
$("cli").addEventListener(
  "change",
  (e) => void save({ cliPath: e.target.value.trim() || null })
);
$("form").addEventListener("submit", (e) => e.preventDefault());

$("choose").addEventListener("click", async () => {
  react("thinking", 30000);
  const path = await window.__TAURI__.dialog.open({
    directory: true,
    title: "你的智能体文件夹",
    defaultPath: settings.folder ?? undefined,
  });
  if (!path) return react("happy", 10);
  await look(path);
  // A new folder starts from its own agent when it's a workspace.
  await save({
    folder: path,
    agent: folder?.isWorkspace ? "" : settings.agent || "claude",
  });
});

$("create").addEventListener("click", async () => {
  const button = $("create");
  button.disabled = true;
  button.textContent = "创建中…";
  react("thinking", 60000);
  try {
    const agent = settings.agent || "claude";
    await invoke("create_workspace", { folder: settings.folder, agent });
    await look(settings.folder);
    await save({ agent: "" });
    react("loved", 2400);
  } catch (error) {
    $("folder-note").className = "note bad";
    $("folder-note").textContent = String(error);
    react("sad", 2400);
  } finally {
    button.disabled = false;
    button.textContent = "在这里创建工作区";
  }
});

$("agent").addEventListener("change", (e) => {
  const agent = e.target.value;
  // A command or a server needs its details first; it's saved once they're typed.
  if (agent === "command" && !settings.agentCommand.trim()) {
    settings = { ...settings, agent };
    fill();
    return $("command").focus();
  }
  if (agent === "server" && !(settings.serverUrl && settings.serverModel)) {
    settings = { ...settings, agent };
    fill();
    return $("server-url").focus();
  }
  void save({ agent });
});
$("command").addEventListener(
  "change",
  (e) => void save({ agent: "command", agentCommand: e.target.value.trim() })
);
for (const id of ["server-url", "server-model"])
  $(id).addEventListener("change", () => {
    const serverUrl = $("server-url").value.trim();
    const serverModel = $("server-model").value.trim();
    if (serverUrl && serverModel)
      void save({ agent: "server", serverUrl, serverModel });
  });

for (const id of ["listen", "speak", "language"])
  $(id).addEventListener("change", (e) => void save({ [id]: e.target.value }));
if (await invoke("has_openai_key"))
  $("openai-key").placeholder = "已保存在钥匙串中";
$("save-key").addEventListener("click", async () => {
  try {
    await invoke("set_openai_key", { key: $("openai-key").value });
    $("openai-key").value = "";
    $("openai-key").placeholder = "已保存在钥匙串中";
    status.textContent = "密钥已保存";
    react("joy");
  } catch (error) {
    status.textContent = String(error).toUpperCase();
    react("oops", 2200);
  }
});

if (await invoke("has_elevenlabs_key"))
  $("elevenlabs-key").placeholder = "已保存在钥匙串中";
$("save-elevenlabs-key").addEventListener("click", async () => {
  try {
    await invoke("set_elevenlabs_key", { key: $("elevenlabs-key").value });
    elevenLabsAsked = false;
    $("elevenlabs-key").value = "";
    $("elevenlabs-key").placeholder = "已保存在钥匙串中";
    status.textContent = "密钥已保存";
    react("joy");
  } catch (error) {
    status.textContent = String(error).toUpperCase();
    react("oops", 2200);
  }
});
$("elevenlabs-voice").addEventListener(
  "change",
  (e) => void save({ elevenlabsVoice: e.target.value })
);
$("elevenlabs-model").addEventListener(
  "change",
  (e) => void save({ elevenlabsModel: e.target.value })
);
// ElevenLabs' own sample of the voice, played here: no credits used.
let sample;
$("try-elevenlabs").addEventListener("click", async () => {
  const id = $("elevenlabs-voice").value || elevenLabsVoices[0]?.id;
  const preview = elevenLabsVoices.find((v) => v.id === id)?.preview;
  if (!preview) {
    status.textContent = "这个声音没有试听";
    react("oops", 2200);
    return;
  }
  sample?.pause();
  sample = new Audio(preview);
  try {
    await sample.play();
    react("cute", 2400);
  } catch (error) {
    status.textContent = String(error).toUpperCase();
    react("oops", 2200);
  }
});

// A newer release found by the charm's daily check: download it from GitHub.
const offered = await invoke("update_offered");
if (offered) {
  $("update").hidden = false;
  $("update").textContent = `OpenCharm ${offered} 已发布。去 GitHub 获取 →`;
  $("update").addEventListener("click", () =>
    invoke("open_release", { version: offered })
  );
}

$("restart").addEventListener("click", async () => {
  await invoke("restart_charmd");
  react("thinking", 2000);
  setTimeout(poll, 300);
});

// Can the charm reach charmd at this address? A WebSocket with the charm's own subprotocol.
$("check").addEventListener("click", () => {
  const note = $("check-note");
  note.className = "note";
  note.textContent = "检查中…";
  react("thinking", 4000);
  let socket;
  try {
    socket = new WebSocket($("url").value.trim(), ["opencharm"]);
  } catch {
    note.className = "note bad";
    note.textContent = "这不是 WebSocket 地址（ws://… 或 wss://…）。";
    react("confused");
    return;
  }
  const done = (ok) => {
    clearTimeout(timer);
    socket.onopen = socket.onerror = null;
    socket.close();
    note.className = ok ? "note ok" : "note bad";
    note.textContent = ok
      ? "charmd 在那里，你的挂件正在与它通信。"
      : "那里没有 charmd。opencharm serve 在运行吗？";
    react(ok ? "joy" : "sad", 2400);
  };
  const timer = setTimeout(() => done(false), 3000);
  socket.onopen = () => done(true);
  socket.onerror = () => done(false);
});

$("forget").addEventListener("click", async () => {
  await invoke("forget_pairing");
  status.textContent = "已忘记配对：请从屏幕顶部重新配对";
  react("surprised", 2000);
});
