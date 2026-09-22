/**
 * 文生图 / 参考图编辑 —— 发布仓「3.1 封面」的出图能力。
 *
 * 走**星辰API（xxcapi.com）的 OpenAI 兼容协议**：
 *   - 文生图   POST /v1/images/generations   （JSON）
 *   - 图像编辑 POST /v1/images/edits         （multipart，可带多张参考图）
 *
 * 之所以两个都要：3.1 文档里的链路是
 *   ① IP 形象照：**结合客户现有参考照片**生成 → 必须走 edits（带参考图）
 *   ② 背景模板 / 每期背景：从零生成 → 走 generations
 *   ③ 完整封面：在背景模板上叠加 IP 形象与标题 → 也走 edits（背景当参考图）
 * 只有 generations 会做不出 ① 和 ③。
 *
 * 🔴 三条纪律：
 *   1. **密钥只从环境变量读**，绝不硬编码、绝不回显、绝不进日志。
 *   2. **请求体与响应体都可能很大（base64 图片）**。日志只记「有没有图 / 多大 / 耗时」，
 *      不记内容 —— 否则日志会被几十 MB 的 base64 撑爆，也等于把客户素材写进日志。
 *   3. `data[].url` 与 `data[].b64_json` 两种返回都要认（网关配置不同返回不同）。
 */

const DEFAULT_BASE_URL = "https://xxcapi.com";
const DEFAULT_MODEL = "gpt-image-2.5-sunburst";
const DEFAULT_TIMEOUT_MS = 180_000;

/** 单张参考图的体积上限。base64 后还会膨胀 4/3，太大网关会直接拒。 */
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;

/** 一次最多几张参考图（IP 形象照 + 背景 + 用户自传，3 张够用）。 */
export const MAX_REFERENCE_IMAGES = 4;

const asText = value => String(value ?? "").trim();

const asNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

/**
 * 读配置。**每次调用都读环境变量**（不缓存），
 * 这样本地改完 `.env` 重启一次就生效，也不会把密钥留在模块级变量里。
 *
 * 🔴 **变量名同时认两套**（`XXCAPI_*` 与 `XINGCHEN_*`）——踩过一次真实故障：
 *    代码只读 `XXCAPI_API_KEY`，而 `.env` 里配的是 `XINGCHEN_API_KEY`（星辰 = xxcapi 的中文名，
 *    部署时按中文名配的）。后果是 `isImageGenerationConfigured()` 恒为 false，
 *    出图**永远回 501**，而报错文案是「服务器未配置出图密钥」——
 *    用户明明配了密钥，却被告知没配，排查方向完全错。
 *    **宽容读取两套名字**比「要求用户改名」稳：改名是人为约定，迟早会再错一次。
 */
const pickEnv = (env, ...names) => {
  for (const name of names) {
    const value = asText(env?.[name]);
    if (value) return value;
  }
  return "";
};

export const getImageConfig = (env = process.env) => ({
  baseUrl: pickEnv(env, "XXCAPI_BASE_URL", "XINGCHEN_BASE_URL") || DEFAULT_BASE_URL,
  apiKey: pickEnv(env, "XXCAPI_API_KEY", "XINGCHEN_API_KEY"),
  model: pickEnv(env, "XXCAPI_IMAGE_MODEL", "XINGCHEN_IMAGE_MODEL") || DEFAULT_MODEL,
  timeoutMs: asNumber(pickEnv(env, "XXCAPI_TIMEOUT_MS", "XINGCHEN_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS),
});

/** 出图功能是否可用（没配 key 就是不可用，由调用方如实降级而不是报 500）。 */
export const isImageGenerationConfigured = (env = process.env) => Boolean(getImageConfig(env).apiKey);

const normalizeSize = value => {
  const text = asText(value);
  // 允许 1K/2K/4K 档位与 `宽x高` 两种写法（网关两种都收）。
  if (/^(1K|2K|4K)$/i.test(text)) return text.toUpperCase();
  if (/^\d{2,5}x\d{2,5}$/i.test(text)) return text;
  return "2K";
};

const normalizeQuality = value => {
  const text = asText(value).toLowerCase();
  return ["auto", "low", "medium", "high", "xhigh", "max"].includes(text) ? text : "high";
};

const normalizeBackground = value => {
  const text = asText(value).toLowerCase();
  return ["opaque", "transparent", "auto"].includes(text) ? text : "opaque";
};

const normalizeAspectRatio = value => {
  const text = asText(value);
  return /^\d{1,2}:\d{1,2}$/.test(text) ? text : "3:4";
};

const normalizeOutputFormat = value => {
  const text = asText(value).toLowerCase();
  return ["png", "jpeg", "webp"].includes(text) ? text : "png";
};

/**
 * 认两种返回形状：
 *   OpenAI 兼容：`{ data: [{ url } | { b64_json }] }`
 *   兜底：`{ images: [...] }` / 顶层 `url`
 * 认不出就抛 —— **不返回空数组让上层以为「生成成功但没图」**。
 */
export const normalizeImageResponse = (payload) => {
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.images)
      ? payload.images
      : [];

  const images = list
    .map(item => {
      if (typeof item === "string") return { url: asText(item), b64: "" };
      return {
        url: asText(item?.url || item?.image_url || item?.imageUrl),
        b64: asText(item?.b64_json || item?.b64Json || item?.base64),
      };
    })
    .filter(item => item.url || item.b64)
    .map(item => ({
      url: item.url,
      // 不回传 base64 全文（几十 MB），只回一个可直接渲染的 data URL 给前端用。
      dataUrl: item.b64 ? toDataUrl(item.b64) : "",
    }));

  // 有些网关把单张图放在顶层。
  if (images.length === 0) {
    const single = asText(payload?.url);
    if (single) images.push({ url: single, dataUrl: "" });
  }
  return images;
};

const toDataUrl = (b64) => {
  const text = asText(b64);
  if (!text) return "";
  if (text.startsWith("data:")) return text;
  // 网关可能不带头，按 png 处理（我们请求的就是 png）。
  return `data:image/png;base64,${text}`;
};

/**
 * 构造带 `code` / `status` 的错误。
 *
 * ⚠️ `status` 必须真的挂到 error 上：两个后端统一按 `error?.status || 500` 取 HTTP 码
 * （全项目惯例）。漏了就变成「本该 501/413 却回 500」，用户看到一个没信息量的服务器错误。
 */
const buildError = (message, code, details) => {
  const error = new Error(message);
  error.code = code;
  if (details?.status) error.status = details.status;
  if (details) error.details = details;
  return error;
};

/** 统一的 fetch 包装：超时 + 把非 2xx 的错误文本带回来（网关的报错很有用）。 */
const postWithTimeout = async (url, init, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw buildError(
        `出图接口返回 ${response.status}`,
        "IMAGE_HTTP_ERROR",
        // 截断：网关报错里可能回带请求体片段，别让日志被撑爆。
        { status: response.status, body: text.slice(0, 500) },
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw buildError("出图接口返回的不是 JSON", "IMAGE_BAD_JSON", { body: text.slice(0, 300) });
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw buildError(`出图超时（${timeoutMs}ms）`, "IMAGE_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 文生图。
 *
 * @param prompt 中文提示词（网关支持中文）
 * @param options { size, quality, background, aspectRatio, model, count, logger }
 * @returns { images: [{ url, dataUrl }], model, elapsedMs }
 */
export const generateImage = async (prompt, options = {}) => {
  const config = options.config || getImageConfig();
  if (!config.apiKey) {
    throw buildError("未配置出图密钥（XXCAPI_API_KEY 或 XINGCHEN_API_KEY）", "IMAGE_NOT_CONFIGURED", { status: 501 });
  }
  const text = asText(prompt);
  if (!text) throw buildError("提示词不能为空", "IMAGE_EMPTY_PROMPT", { status: 400 });

  const logger = options.logger;
  const startedAt = Date.now();
  const body = {
    model: asText(options.model) || config.model,
    prompt: text,
    size: normalizeSize(options.size),
    quality: normalizeQuality(options.quality),
    background: normalizeBackground(options.background),
    aspectRatio: normalizeAspectRatio(options.aspectRatio),
    n: Math.max(1, Math.min(4, Number(options.count) || 1)),
    response_format: "url",
  };
  // `provider` 字段按网关说明**不要传**（传了会与模型变体冲突）。

  logger?.info("image.generate.start", {
    model: body.model,
    size: body.size,
    quality: body.quality,
    promptLength: text.length,
  });

  const payload = await postWithTimeout(
    joinUrl(config.baseUrl, "/v1/images/generations"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    config.timeoutMs,
  );

  const images = normalizeImageResponse(payload);
  const elapsedMs = Date.now() - startedAt;
  if (images.length === 0) {
    throw buildError("出图接口没有返回任何图片", "IMAGE_EMPTY_RESULT");
  }
  logger?.info("image.generate.done", {
    model: body.model,
    imageCount: images.length,
    elapsedMs,
    // 只记「从 url 还是 base64 回来的」，不记内容。
    via: images[0]?.dataUrl ? "b64" : "url",
  });
  return { images, model: body.model, elapsedMs };
};

/**
 * 参考图编辑（multipart）。用于 3.1 的「结合客户参考照片生成 IP 形象照」与
 * 「在背景模板上合成完整封面」。
 *
 * @param prompt        编辑指令
 * @param referenceImages [{ url, dataUrl, name }]（可多张；单张超限直接报错，
 *                        避免把几十 MB 打给网关等到超时才发现）
 */
export const editImage = async (prompt, referenceImages = [], options = {}) => {
  const config = options.config || getImageConfig();
  if (!config.apiKey) {
    throw buildError("未配置出图密钥（XXCAPI_API_KEY 或 XINGCHEN_API_KEY）", "IMAGE_NOT_CONFIGURED", { status: 501 });
  }
  const text = asText(prompt);
  if (!text) throw buildError("编辑指令不能为空", "IMAGE_EMPTY_PROMPT", { status: 400 });

  const list = (Array.isArray(referenceImages) ? referenceImages : []).filter(Boolean).slice(0, MAX_REFERENCE_IMAGES);
  if (list.length === 0) {
    throw buildError("图像编辑至少需要一张参考图", "IMAGE_NO_REFERENCE", { status: 400 });
  }

  const logger = options.logger;
  const startedAt = Date.now();
  const form = new FormData();
  form.append("model", asText(options.model) || config.model);
  form.append("prompt", text);
  form.append("size", normalizeSize(options.size));
  form.append("quality", normalizeQuality(options.quality));
  form.append("background", normalizeBackground(options.background));
  form.append("aspect_ratio", normalizeAspectRatio(options.aspectRatio));
  form.append("output_format", normalizeOutputFormat(options.outputFormat));

  let totalBytes = 0;
  for (const [index, item] of list.entries()) {
    const bytes = await resolveReferenceBytes(item);
    if (bytes.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
      throw buildError(
        `第 ${index + 1} 张参考图过大（${Math.round(bytes.byteLength / 1024)}KB，上限 ${Math.round(MAX_REFERENCE_IMAGE_BYTES / 1024)}KB）`,
        "IMAGE_REFERENCE_TOO_LARGE",
        { status: 413 },
      );
    }
    totalBytes += bytes.byteLength;
    form.append("image[]", new Blob([bytes], { type: bytes.type || "image/png" }), `reference-${index + 1}.png`);
  }

  logger?.info("image.edit.start", {
    model: form.get("model"),
    referenceCount: list.length,
    totalBytes,
    promptLength: text.length,
  });

  const payload = await postWithTimeout(
    joinUrl(config.baseUrl, "/v1/images/edits"),
    { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}` }, body: form },
    config.timeoutMs,
  );

  const images = normalizeImageResponse(payload);
  const elapsedMs = Date.now() - startedAt;
  if (images.length === 0) {
    throw buildError("图像编辑没有返回任何图片", "IMAGE_EMPTY_RESULT");
  }
  logger?.info("image.edit.done", { imageCount: images.length, elapsedMs });
  return { images, model: form.get("model"), elapsedMs };
};

const joinUrl = (baseUrl, path) => `${asText(baseUrl).replace(/\/+$/, "")}${path}`;

/**
 * 把参考图统一取成字节。支持：
 *   - `dataUrl`（用户在前端上传的照片 → base64）
 *   - `url`（http(s)，例如对标账号封面、之前生成的背景模板）
 * 两者都没有就报错，不静默跳过（少一张参考图会改变出图结果，用户看不出来）。
 */
const resolveReferenceBytes = async (item) => {
  const dataUrl = asText(item?.dataUrl);
  if (dataUrl.startsWith("data:")) {
    const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) throw buildError("参考图的 data URL 格式不对", "IMAGE_BAD_REFERENCE", { status: 400 });
    const mime = match[1] || "image/png";
    const buffer = Buffer.from(match[3], match[2] ? "base64" : "utf8");
    buffer.type = mime;
    return buffer;
  }

  const url = asText(item?.url);
  if (!url) throw buildError("参考图缺少 url 或 dataUrl", "IMAGE_BAD_REFERENCE", { status: 400 });
  const response = await fetch(url);
  if (!response.ok) {
    throw buildError(`下载参考图失败（${response.status}）`, "IMAGE_REFERENCE_DOWNLOAD_FAILED", { status: 400 });
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  buffer.type = response.headers.get("content-type") || "image/png";
  return buffer;
};
