// The voice models' first download (about 600 MB), as charmd reports it (voice_progress), in words.
// A failed one is tried again on a turn a few minutes later (packages/charmd/src/voice/models.ts).

// charmd names the model and what it's for; its words are English.
const inWords = (model) =>
  model
    .replace(" (listening)", "（聆听）")
    .replace(" (speaking)", "（说话）")
    .replace(" downloading ", " 正在下载 ")
    .replace(/ failed$/, " 失败");

export function describeModels(models) {
  const loading = models
    .filter((m) => m.includes(" downloading "))
    .map(inWords);
  const failed = models
    .filter((m) => m.endsWith(" failed"))
    .map((m) => inWords(m).replace(/ 失败$/, ""));
  return [
    loading.length ? `正在准备它的声音（仅首次）：${loading.join("、")}。` : "",
    failed.length
      ? `无法下载 ${failed.join(" 和 ")}；几分钟后你说话时它会再试。`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
