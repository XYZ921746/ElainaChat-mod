/* ============================================================================
 * 情景演绎（Live2D 舞台）
 *
 * 住在 galgame 插件目录里：把原先独立的「Live2D 视频通话」插件并进了 Galgame。
 * 两者本来就是同一件事的两种呈现（剧情对话框 / 全屏通话），拆成两个包时用的是
 * 两个开关、市场里还得装两次。现在**一个包**：剧情界面是主界面，本文件提供它的
 * 「情景演绎」入口。
 *
 * 引擎与模型仍在资源插件「Live2D 引擎与模型」（live2d-models）里，
 * 本文件只负责**界面与表现**（全屏舞台、口型、表情/动作/情绪驱动）。
 *
 * ── 依赖 ───────────────────────────────────────────────────────────────────
 *   manifest.after = ['live2d-models']  —— 缺它会被**拒绝加载**（不是带病运行），
 *   因为它提供引擎（ElainaLive2DModels.ensureEngine）与模型清单。
 *
 * ── 为什么仍然挂 window.Live2DCall ───────────────────────────────────────
 *   宿主有约 30 处 window.Live2DCall?.xxx 调用点（设置面板、语音口型、
 *   Agent 表情、提示词注入）。保留这个全局名，那些调用点就**一行都不用改** ——
 *   搬迁风险最小。插件被停用时它自然消失，调用点本来就有守卫。
 *
 * ── 标签协议（只做"表现"，不碰 Agent）─────────────────────────────────────
 *   剥离与 [操作:] 分发归宿主 web/js/agent-tags.js；本插件只提供
 *   表情/动作/情绪/位置/大小/背景，并把自己的两个操作（水印/静音）
 *   通过 ElainaTags.registerOperationHandler 追加进宿主的分发链。
 * ========================================================================== */
function initLive2DCore(host) {
  'use strict';
  globalThis.ElainaMerge = true;

  // 资源插件：引擎与模型都从它取（缺它本插件根本不会加载，见 manifest.after）
  const models = host.require('live2d-models');

  // 舞台自己的偏好走 host.storage（落 data/、跨设备同步、停用可清理）。
  // 保留 getItem/setItem/removeItem/length/key 的旧调用形状，只换底层。
  const LS = {
    getItem(k) { try { return host.storage.get(k, null); } catch (e) { return null; } },
    setItem(k, v) { try { host.storage.set(k, String(v)); } catch (e) { /* 忽略 */ } },
    removeItem(k) { try { host.storage.remove(k); } catch (e) { /* 忽略 */ } },
    get length() { try { return host.storage.keys().length; } catch (e) { return 0; } },
    key(i) { try { return host.storage.keys()[i] ?? null; } catch (e) { return null; } },
  };


  let app = null;
  let model = null;
  let container = null;
  let isOpen = false;
  let speaking = false;
  let mouthEnergy = 1; // 情绪驱动的说话嘴型幅度（激动大/平静小）
  let rafRunning = false;
  let currentExpression = null;
  let modelsList = [];
  let selectedModel = '';
  let currentModelExps = [];   // 当前模型可用表情文件名（.exp3.json，供 AI 决策）
  let currentModelMotions = []; // 当前模型可用动作文件名（.motion3.json，供 AI 决策）
  // 清单是否已从服务端拿到（区分"未知"与"确定为空"，见 resolveExpressionFile）
  let modelAssetListKnown = false;
  // 模型尺寸/位置状态（图片网格式拖拽调整）
  //   sx/sy: 模型绝对缩放倍数
  //   cx/cy: 模型中心在屏幕上的位置比例（0~1）
  // 每个模型独立记忆（live2d.resize.<模型名>），兼容旧版全局 live2d.resize / live2d.scale
  let resizeState = { sx: 1, sy: 1, cx: 0.5, cy: 0.5 };
  let legacyScaleHint = null; // 旧版 live2d.scale（高度占屏幕比例）迁移用
  let needsInitScale = false; // 首次使用：按高度 65% 自适应
  // 水印开关（通用探测：模型 exp 目录含"水印"的表情，如 悠小喵「水印开关」Param85=1）
  let watermarkExp = null;   // 探测到的水印开关表情文件名（如 水印开关.exp3.json）
  let watermarkParamId = null; // 该表情设置的参数 Id（如 Param85）
  let watermarkValue = 1;    // 该表情设置的参数值（隐藏水印的值，默认 1）
  let watermarkOn = false;   // 当前水印是否已隐藏
  let watermarkKeyHandler = null; // 键盘监听引用（open/close 挂载/卸载）
  // 鼠标追踪（模型头部/眼睛跟随鼠标）
  let mouseTarget = { x: 0, y: 0 };
  let mouseCurrent = { x: 0, y: 0 };
  let mouseTrackRaf = null;
  let mouseMoveHandler = null;
  // 语音音量（VAD）：真实 TTS 音量驱动嘴型（null = 用正弦波模拟）
  let voiceEnergy = null;

  /**
   * 存储键命名空间：galgame.live2d.*
   *
   * 合并前这些键是 live2d.*（原插件自己的地盘），合并后代码住在 galgame 包里，
   * 再沿用 live2d. 前缀既看不出归属、也会和「Live2D 引擎与模型」资源插件的键混在一起。
   * 老用户的键由 migrateL2dStorage 一次性搬过来，不必重调模型大小/背景。
   */
  const L2D_PREFIX = 'galgame.live2d.';

  /**
   * 把旧键 live2d.* 迁到 galgame.live2d.*。
   *
   * 只搬"新键还不存在"的那些：新键已存在说明用户在新版本里改过，旧值更旧，覆盖就是倒退。
   * 旧键不删 —— 占用很小，留着可回滚；所有读取点只看新前缀。
   */
  function migrateL2dStorage() {
    try {
      const legacy = [];
      for (let i = 0; i < LS.length; i++) {
        const k = LS.key(i);
        if (k && k.indexOf('live2d.') === 0) legacy.push(k);
      }
      for (const k of legacy) {
        const next = L2D_PREFIX + k.slice('live2d.'.length);
        if (LS.getItem(next) === null) LS.setItem(next, LS.getItem(k) || '');
      }
    } catch (e) { /* 配额满/隐私模式：读不到旧值就从默认开始，不影响使用 */ }
  }
  migrateL2dStorage();

  function resizeStorageKey() { return selectedModel ? L2D_PREFIX + 'resize.' + selectedModel : L2D_PREFIX + 'resize'; }

  function sanitizeResize(o) {
    const s = {};
    // 只做宽范围防垃圾值，精确钳制在 applyModelSize 里按屏幕/模型动态计算
    s.sx = isFinite(o.sx) && o.sx > 0 ? Math.min(1e6, Math.max(1e-4, o.sx)) : 1;
    s.sy = isFinite(o.sy) && o.sy > 0 ? Math.min(1e6, Math.max(1e-4, o.sy)) : s.sx;
    s.cx = isFinite(o.cx) ? Math.min(1, Math.max(0, o.cx)) : 0.5;
    s.cy = isFinite(o.cy) ? Math.min(1, Math.max(0, o.cy)) : 0.5;
    return s;
  }

  function loadResizeState() {
    // 1) 当前模型专属
    if (selectedModel) {
      try {
        const raw = LS.getItem(L2D_PREFIX + 'resize.' + selectedModel);
        if (raw) {
          const o = JSON.parse(raw);
          if (o && isFinite(o.sx) && o.sx > 0) return sanitizeResize(o);
        }
      } catch { /* ignore */ }
    }
    // 2) 旧版全局（本次改造前的 live2d.resize）
    try {
      const raw = LS.getItem(L2D_PREFIX + 'resize');
      if (raw) {
        const o = JSON.parse(raw);
        if (o && isFinite(o.sx) && o.sx > 0) return sanitizeResize(o);
      }
    } catch { /* ignore */ }
    // 3) 旧版 live2d.scale = 高度占屏幕比例（0.2~1.2），迁移到新格式
    try {
      const old = parseFloat(LS.getItem(L2D_PREFIX + 'scale'));
      if (isFinite(old) && old > 0) {
        legacyScaleHint = Math.min(1.2, Math.max(0.2, old));
        return { sx: 1, sy: 1, cx: 0.5, cy: 0.5 };
      }
    } catch { /* ignore */ }
    needsInitScale = true;
    return { sx: 1, sy: 1, cx: 0.5, cy: 0.5 };
  }

  function saveResizeState() {
    try { LS.setItem(resizeStorageKey(), JSON.stringify(resizeState)); } catch { /* ignore */ }
  }

  // 模型在 scale=1 时的自然包围盒（模型单位，高度约 1~2）
  function modelUnitBounds() {
    try {
      const b = model.getLocalBounds();
      if (b.width > 0 && b.height > 0 && isFinite(b.width) && isFinite(b.height)) return { w: b.width, h: b.height };
    } catch { /* ignore */ }
    try {
      const im = model.internalModel;
      if (im && isFinite(im.width) && im.width > 0 && isFinite(im.height) && im.height > 0) return { w: im.width, h: im.height };
    } catch { /* ignore */ }
    return null;
  }

  // 动态钳制：渲染高度限制在屏幕高的 2%~600%
  function clampScale(v) {
    if (!isFinite(v) || v <= 0) return 0.01;
    let min = 0.01, max = 100;
    if (model && app && app.screen.height > 0) {
      const u = modelUnitBounds();
      if (u && u.h > 0) {
        min = (0.02 * app.screen.height) / u.h;
        max = (6 * app.screen.height) / u.h;
      }
    }
    return Math.min(max, Math.max(min, v));
  }

  const EXPRESSION_MAP = {
    happy: '星星眼', sad: '哭哭', blush: '脸红', dizzy: '晕晕眼', angry: '黑脸',
    think: '前倾', smile: '常规', cry: '流泪', shy: '扶脸', phone: '看手机',
    note: '记笔记', fly: '飞头',
  };
  const MOTION_MAP = { wave: '常规', bow: '前倾' };

  // 情绪系统：情绪 → 表情 + 说话嘴型幅度 + 触发词/emoji（用于无标签时自动推断）
  // LLM 回复可用 [情绪:xxx] 显式驱动；未带标签时按触发词自动推断
  const EMOTION_MAP = {
    happy: { exp: 'happy', energy: 1.2, keys: ['开心', '高兴', '哈哈', '太好了', '太棒了', '真棒', '真开心', '喜欢', '笑死', '不错嘛', '好耶', '开心', '😄', '😆', '🥳', '😊', '🎉'] },
    sad: { exp: 'sad', energy: 0.65, keys: ['难过', '伤心', '呜呜', '想哭', '悲伤', '遗憾', '不开心', '好难过', '失落', '😢', '😭', '💔'] },
    angry: { exp: 'angry', energy: 1.35, keys: ['生气', '愤怒', '哼', '讨厌', '可恶', '气死', '真气人', '烦死了', '😡', '😠', '💢'] },
    shy: { exp: 'blush', energy: 0.85, keys: ['害羞', '脸红', '不好意思', '讨厌啦', '别这样', '难为情', '😳', '🥰'] },
    surprised: { exp: 'dizzy', energy: 1.4, keys: ['惊讶', '震惊', '哇', '居然', '不会吧', '天哪', '真的假的', '😮', '😱', '🤯'] },
    cry: { exp: 'cry', energy: 0.55, keys: ['委屈', '哭唧唧', '泪流', '哇哇哭'] },
    think: { exp: 'think', energy: 0.8, keys: ['思考', '想想', '让我想想', '嗯…', '嗯...', '让我想想', '🤔'] },
    dizzy: { exp: 'dizzy', energy: 0.7, keys: ['晕', '头晕', '天旋地转', '😵'] },
    calm: { exp: 'smile', energy: 1.0, keys: ['平静', '嗯嗯', '好的', '没事', '放心', '😌'] },
  };

  // ===== DOM =====
  function buildUI() {
    const layer = document.createElement('div');
    layer.id = 'live2d-call-host';
    layer.innerHTML = `
      <div id="live2d-stage" class="live2d-stage">
        <!-- 右上角只留退出。语音输入在下方聊天框那一行（麦克风就在输入框旁边）。 -->
        <button id="live2d-exit-btn" class="live2d-exit-btn" type="button" title="退出情景演绎" aria-label="退出情景演绎">✕</button>
        <div id="live2d-canvas-wrap" class="live2d-canvas-wrap">
          <canvas id="live2d-canvas"></canvas>
          <!-- 立绘模式：同一个舞台里只放立绘，气泡位置、打字机、输入行全部复用 -->
          <div id="ggL2dPortrait" class="live2d-portrait">
            <img id="ggL2dPortraitImg" alt="伊蕾娜">
            <div id="ggL2dPortraitEmpty" class="live2d-portrait-empty">切换到「图片立绘」并启用「伊蕾娜立绘与情绪」后，这里会显示立绘</div>
          </div>
          <div id="live2d-bubble-wrap" class="live2d-bubble-wrap">
            <div id="live2d-gg-dialog" class="live2d-gg-dialog">
              <div id="live2d-gg-name">伊蕾娜</div>
              <div id="live2d-gg-text" class="gg-stext"></div>
              <div id="live2d-gg-input-row" class="gg-srow">
                <input id="live2d-gg-input" type="text" placeholder="和伊蕾娜说点什么…（回车发送）" autocomplete="off">
                <button id="live2d-mic-btn" class="gg-mic-btn" type="button" title="语音输入：点一下开始说话" aria-label="语音输入">🎤</button>
                <button id="live2d-gg-send" type="button" title="发送">➤</button>
              </div>
            </div>
          </div>
          <div class="live2d-name-tag" id="live2d-name-tag">情景演绎中</div>
          <div class="live2d-follow-hint" id="live2d-follow-hint" title="点击开启鼠标跟随">鼠标跟随已关闭 · 点此开启</div>
          <div id="live2d-resize-box" class="live2d-resize-box" title="拖动移动 · 拖手柄调整大小">
            <div class="live2d-handle" data-dir="nw"></div>
            <div class="live2d-handle" data-dir="n"></div>
            <div class="live2d-handle" data-dir="ne"></div>
            <div class="live2d-handle" data-dir="e"></div>
            <div class="live2d-handle" data-dir="se"></div>
            <div class="live2d-handle" data-dir="s"></div>
            <div class="live2d-handle" data-dir="sw"></div>
            <div class="live2d-handle" data-dir="w"></div>
          </div>
        </div>
        <div class="live2d-bottombar">
          <button id="live2d-adjust-toggle" class="live2d-adjust-btn" title="显示/隐藏模型调整框">📐</button>
        </div>
      </div>
    `;
    document.body.appendChild(layer);

    const style = document.createElement('style');
    style.textContent = `
      /* 兼容旧 WebView（Chromium < 87 不支持 inset 简写）：用长属性兜底，避免通话浮层定位失效飘到左上角 */
      #live2d-call-host { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 950; display: none; }
      #live2d-call-host.open { display: block; }
      .live2d-stage { width: 100%; height: 100%; background: #0b0e14; position: relative; overflow: hidden; }
      /* 右上角退出：舞台唯一的常驻控件（模型选择在设置页里） */
      .live2d-exit-btn {
        position: absolute; top: 14px; right: 16px; z-index: 7;
        width: 34px; height: 34px; border-radius: 50%; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        color: #fff; font-size: 15px; line-height: 1;
        background: rgba(10,14,22,.52); border: 1px solid rgba(255,255,255,.22);
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        transition: background .15s, transform .15s;
      }
      .live2d-exit-btn:hover { background: rgba(239,68,68,.75); transform: scale(1.05); }
      /* 朗读开关：与退出按钮同款，但平时更低调（不是"离开"那种破坏性动作） */
      /* 语音输入：聊天框那一行、发送键左边（和主界面的麦克风同一个位置习惯） */
      .gg-mic-btn {
        flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%; cursor: pointer;
        border: 1px solid rgba(255,255,255,.22); background: rgba(10,14,22,.78);
        color: #fff; font-size: 16px; line-height: 1; transition: background .15s, transform .15s;
      }
      .gg-mic-btn:hover { background: rgba(255,255,255,.22); transform: scale(1.04); }
      .gg-mic-btn.is-listening {
        background: rgba(239,68,68,.82); border-color: rgba(255,255,255,.4);
        animation: gg-mic-beat 1.2s ease-in-out infinite;
      }
      @keyframes gg-mic-beat { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      .live2d-canvas-wrap { position: absolute; top: 0; right: 0; bottom: 0; left: 0; }
      #live2d-canvas { width: 100%; height: 100%; display: block; }
      /* 立绘模式：立绘与 Live2D 共用同一个位置，切换时只换内容 */
      .live2d-portrait { position: absolute; top: 0; right: 0; bottom: 0; left: 0; display: none; align-items: flex-end; justify-content: center; pointer-events: none; }
      .live2d-portrait.on { display: flex; }
      #live2d-call-host.portrait #live2d-canvas { display: none; }
      #ggL2dPortraitImg { max-height: 88%; max-width: 78%; object-fit: contain; object-position: bottom center; filter: drop-shadow(0 18px 40px rgba(0,0,0,.5)); transition: opacity .25s ease; }
      #ggL2dPortraitImg.emo-swap { animation: gg-l2d-pop .32s cubic-bezier(.3,1.4,.5,1) both; }
      @keyframes gg-l2d-pop { from { opacity: .4; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
      .live2d-portrait-empty { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); max-width: 340px; text-align: center; color: rgba(255,255,255,.55); font-size: 12px; line-height: 1.8; padding: 14px 18px; border: 1px dashed rgba(255,255,255,.2); border-radius: 14px; }
      /* 气泡：复用剧情界面的观感（半透明深色 + 打字机 + 悬浮输入行） */
      .live2d-bubble-wrap { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 4vw 92px; display: flex; justify-content: center; z-index: 4; pointer-events: none; }
      .live2d-gg-dialog { position: relative; width: min(1080px, 94vw); min-height: 150px; padding: 18px 26px 20px; border-radius: 22px; background: rgba(12,16,26,.62); border: 1px solid rgba(255,255,255,.16); box-shadow: 0 18px 50px rgba(0,0,0,.42); backdrop-filter: blur(9px); -webkit-backdrop-filter: blur(9px); color: #fff; pointer-events: auto; }
      #live2d-gg-name { display: inline-block; margin-bottom: 6px; font-size: 15px; font-weight: 800; color: #bfe3ff; }
      .gg-stext { min-height: 3.7em; max-height: 32vh; overflow-y: auto; font-size: 16.5px; line-height: 1.85; letter-spacing: .01em; color: #fff; white-space: pre-wrap; word-break: break-word; scrollbar-width: none; }
      .gg-stext::-webkit-scrollbar { display: none; }
      .gg-stext.typing::after { content: "▍"; margin-left: 2px; animation: gg-l2d-caret .9s steps(1) infinite; }
      @keyframes gg-l2d-caret { 50% { opacity: 0; } }
      /* 输入行：跟随气泡在文档流里（不用 hover 展开 —— 触屏没有 hover，
         原来那套"鼠标移上去才出现"在手机上等于没有输入框） */
      .gg-srow { display: flex; gap: 10px; margin-top: 10px; }
      #live2d-gg-input { flex: 1 1 auto; height: 44px; border-radius: 14px; padding: 0 16px; border: 1px solid rgba(255,255,255,.22); background: rgba(10,14,22,.78); color: #fff; outline: none; font-size: 14px; }
      #live2d-gg-input::placeholder { color: rgba(255,255,255,.4); }
      #live2d-gg-send { flex: 0 0 auto; width: 44px; height: 44px; border: 0; border-radius: 50%; cursor: pointer; background: rgba(0,122,255,.85); color: #fff; font-size: 16px; }
      @media (max-width: 560px) {
        .live2d-bubble-wrap { padding: 0 3vw 84px; }
        .live2d-gg-dialog { min-height: 132px; padding: 14px 16px 16px; border-radius: 18px; }
        .gg-stext { font-size: 15px; max-height: 30vh; }
        #ggL2dPortraitImg { max-width: 100%; max-height: 100%; }
      }
      .live2d-name-tag { position: absolute; bottom: 84px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,.85); font-size: 13px; background: rgba(0,0,0,.4); padding: 4px 14px; border-radius: 999px; white-space: nowrap; }
      /* 鼠标跟随关闭时的提示：让"模型不动"这件事自解释，而不是让人以为模型坏了 */
      .live2d-follow-hint { position: absolute; bottom: 132px; left: 50%; transform: translateX(-50%); color: #fcd34d; font-size: 12px; display: none; background: rgba(0,0,0,.55); padding: 5px 14px; border-radius: 999px; cursor: pointer; z-index: 6; white-space: nowrap; }
      .live2d-follow-hint.on { display: block; }
      .live2d-bottombar { position: absolute; bottom: 0; left: 0; right: 0; padding: 16px 20px calc(20px + env(safe-area-inset-bottom)); display: flex; gap: 14px; justify-content: center; align-items: center; z-index: 5; }
      .live2d-adjust-btn { background: rgba(255,255,255,.14); border: none; color: #fff; width: 54px; height: 54px; border-radius: 50%; font-size: 22px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .15s; }
      .live2d-adjust-btn:hover { background: rgba(255,255,255,.28); }
      .live2d-adjust-btn.active { background: rgba(129,199,255,.35); color: #fff; box-shadow: 0 0 0 2px rgba(129,199,255,.7); }
      .live2d-bg-panel { position: absolute; top: 52px; left: 50%; transform: translateX(-50%); z-index: 6; background: rgba(20,22,35,.92); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 14px 16px; width: 320px; backdrop-filter: blur(10px); }
      .live2d-bg-panel.hidden { display: none; }
      .live2d-bg-head { color: #fff; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
      .live2d-bg-section { margin-bottom: 10px; }
      .live2d-bg-title { color: rgba(255,255,255,.65); font-size: 11px; margin-bottom: 6px; }
      .live2d-bg-options { display: flex; flex-wrap: wrap; gap: 8px; }
      .live2d-bg-swatch { width: 36px; height: 36px; border-radius: 10px; cursor: pointer; border: 2px solid rgba(255,255,255,.15); position: relative; transition: transform .12s; }
      .live2d-bg-swatch:hover { transform: scale(1.1); border-color: #fff; }
      .live2d-bg-custom { display: flex; align-items: center; justify-content: center; font-size: 16px; background: rgba(255,255,255,.08); }
      /* 模型调整框：虚线边框 + 8 个拖拽手柄（默认隐藏，点「调整」按钮开关） */
      .live2d-resize-box { position: absolute; z-index: 4; border: 1.5px dashed rgba(255,255,255,.6); box-sizing: border-box; display: none; cursor: move; touch-action: none; }
      .live2d-resize-box.show { display: block; }
      .live2d-resize-box.resizing { border-style: solid; border-color: rgba(129,199,255,.9); }
      .live2d-handle { position: absolute; width: 12px; height: 12px; background: #fff; border: 1.5px solid #0b0e14; border-radius: 3px; box-shadow: 0 0 4px rgba(0,0,0,.5); box-sizing: border-box; touch-action: none; }
      .live2d-handle[data-dir="nw"] { top: -7px; left: -7px; cursor: nwse-resize; }
      .live2d-handle[data-dir="n"] { top: -7px; left: 50%; margin-left: -6px; cursor: ns-resize; }
      .live2d-handle[data-dir="ne"] { top: -7px; right: -7px; cursor: nesw-resize; }
      .live2d-handle[data-dir="e"] { top: 50%; margin-top: -6px; right: -7px; cursor: ew-resize; }
      .live2d-handle[data-dir="se"] { bottom: -7px; right: -7px; cursor: nwse-resize; }
      .live2d-handle[data-dir="s"] { bottom: -7px; left: 50%; margin-left: -6px; cursor: ns-resize; }
      .live2d-handle[data-dir="sw"] { bottom: -7px; left: -7px; cursor: nesw-resize; }
      .live2d-handle[data-dir="w"] { top: 50%; margin-top: -6px; left: -7px; cursor: ew-resize; }
      .live2d-handle:hover { background: #bde0ff; }
      .live2d-adjust-btn.active { background: rgba(129,199,255,.35); color: #fff; box-shadow: 0 0 0 2px rgba(129,199,255,.7); }
    `;
    document.head.appendChild(style);

    layer.querySelector('#live2d-exit-btn').addEventListener('click', close);

    // 语音输入（聊天框那一行、发送键左边）：开麦 / 结束并发送。
    //   识别结果由宿主直接发出去（与主界面麦克风同一链路），所以这里不拿文本 ——
    //   舞台的气泡轮询会看到那条用户消息。
    //   没配置 ASR 时按钮隐藏：让用户点一下再弹"未配置"是最差的一种设计。
    const micBtn = layer.querySelector('#live2d-mic-btn');
    if (micBtn) {
      const micState = () => {
        try { return typeof host.dictationState === 'function' ? String(host.dictationState()) : 'idle'; } catch (e) { return 'idle'; }
      };
      const syncMicBtn = () => {
        let configured = false;
        try { configured = typeof host.dictationConfigured === 'function' && host.dictationConfigured(); } catch (e) { configured = false; }
        micBtn.style.display = configured ? '' : 'none';
        const st = micState();
        const listening = st === 'listening' || st === 'paused';
        micBtn.classList.toggle('is-listening', listening);
        micBtn.textContent = listening ? '⏹' : '🎤';
        micBtn.title = listening ? '结束并发送' : '语音输入：点一下开始说话';
      };
      micBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        try {
          if (typeof host.dictate === 'function') host.dictate();
        } catch (e) { host.error('语音输入不可用', e); }
        // 宿主的状态是异步推进的：点完先同步一次，再隔几拍对齐（识别结束会自己变回 idle）
        syncMicBtn();
        [300, 900, 1800].forEach((ms) => setTimeout(syncMicBtn, ms));
      });
      // 宿主每次改语音状态都会派发 voice-state 事件（见 settings.js 的 updateUI），
      //   跟着它刷新按钮，比轮询便宜也更即时。
      window.addEventListener('voice-state', syncMicBtn);
      syncMicBtn();
    }
    layer.querySelector('#live2d-adjust-toggle').addEventListener('click', toggleAdjustBox);
    // 气泡输入行：和剧情界面一样"回车发送"。发送走 host.sendUserMessage，
    // 与主界面共用同一份对话数据 —— 两边说的互相可见。
    const sendBtn = layer.querySelector('#live2d-gg-send');
    const inputEl = layer.querySelector('#live2d-gg-input');
    if (sendBtn) sendBtn.addEventListener('click', (ev) => { ev.stopPropagation(); sendBubbleText(); });
    if (inputEl) {
      inputEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); sendBubbleText(); }
      });
      inputEl.addEventListener('click', (ev) => ev.stopPropagation());
    }
    // 「鼠标跟随已关闭」提示：点击直接开启，避免用户误以为是模型不支持
    const followHint = layer.querySelector('#live2d-follow-hint');
    if (followHint) followHint.addEventListener('click', () => setMouseFollow(true));
    // 注意：鼠标追踪监听器不在这里挂载（buildUI 只在首次打开时执行一次），
    // 否则 close() 移除监听后再次打开通话将永远不会重新挂载 —— 见 ensureMouseTracking()

    // 调整框拖拽：手柄缩放 / 框内移动
    const box = layer.querySelector('#live2d-resize-box');
    box.querySelectorAll('.live2d-handle').forEach(h => {
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e, 'resize', h.dataset.dir);
      });
    });
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startDrag(e, 'move', '');
    });
    box.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      e.preventDefault();
      moveDrag(e);
    });
    const endDragHandler = () => endDrag();
    box.addEventListener('pointerup', endDragHandler);
    box.addEventListener('pointercancel', endDragHandler);
    box.addEventListener('lostpointercapture', endDragHandler);
  }

  // ===== 模型管理 =====
  async function refreshModelList() {
    // APK 首次启动会把打包进来的内置模型复制到应用数据目录（见 index.html）。
    // 种的过程还没结束时先等一下，否则刚装好打开通话会看到"未上传模型"。
    if (window.__nativeSeedPromise) {
      try { await window.__nativeSeedPromise; } catch { /* 种失败不影响用户自己上传的模型 */ }
    }
    try {
      const res = await fetch('/api/live2d/models');
      const json = await res.json();
      modelsList = (json.models || []).filter(m => m && m.name);
    } catch (err) {
      console.warn('[Live2D] 获取模型列表失败:', err.message || err);
      modelsList = [];
    }
    // 先确定"用哪个模型"：舞台里已经没有模型下拉，这一步不能跟着下拉一起被跳过
    //   （否则删掉下拉后 selectedModel 一直是空，loadModel 直接 return，舞台没有模型）。
    if (modelsList.length && (!selectedModel || !modelsList.some(m => m.name === selectedModel))) {
      selectedModel = modelsList[0].name;
    }
  }

  function getSelectedModelInfo() {
    return modelsList.find(m => m.name === selectedModel) || null;
  }

  /**
   * 在**不打开通话**的情况下确定"当前用哪个模型"。
   *
   * 为什么需要：selectedModel 原先只在 refreshModelList 里赋值，
   *   而那个函数只在**打开通话时**调用 —— 于是没开过通话之前，
   *   「Live2D 引擎与模型」的卡片界面拿不到当前选择，**一张卡都不会标「正在使用」**，
   *   用户看不出自己用的是哪个。
   *
   *   这里在插件加载后拉一次列表、补上默认选择。失败不影响任何功能
   *   （只是卡片上暂时没有"正在使用"标记），所以整段静默兜住。
   */
  async function initSelectedModel() {
    try {
      const res = await fetch('/api/live2d/models');
      if (!res.ok) return;
      const json = await res.json();
      const list = (json.models || []).filter(m => m && m.name);
      if (!list.length) return;
      modelsList = list;
      // 只有"还没选"或"选的那个已经不在了"才改写 —— 否则会把用户的选择顶掉
      if (!selectedModel || !list.some(m => m.name === selectedModel)) {
        selectedModel = list[0].name;
      }
    } catch (e) { /* 静默：拿不到列表不影响功能，只是卡片暂时没有标记 */ }
  }

  /**
   * 服务端把模型【目录】改名后，同步客户端这边所有按模型名存的东西。
   * 目录名是"每模型设置"的 key，不迁移的话改名后模型会回到默认大小、水印开关也会丢。
   * 顺带把 selectedModel 指到新名字，否则下拉会掉选到第一个模型。
   */
  function applyRenamedModel(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return Promise.resolve();
    if (selectedModel === oldName) selectedModel = newName;
    try {
      for (const suffix of ['resize.', 'wm.']) {
        const prefix = L2D_PREFIX + suffix;
        const v = LS.getItem(prefix + oldName);
        if (v !== null) {
          LS.setItem(prefix + newName, v);
          LS.removeItem(prefix + oldName);
        }
      }
    } catch { /* ignore */ }
    return refreshModelList();
  }

  // 模型资源基础 URL：Web 版走服务端 /live2d/models/；Capacitor（APK）走本地文件系统
  // 注意 `bundled` 那一路：数据目录为空时，模型列表会回退成"直接读打包进 APK 的 assets"
  // （见 index.html 的 bundledManifestModels）。那种情况下资源**不在数据目录里**，
  // 必须走 /live2d/models/（WebView 的静态资源），否则会拼出一个指向数据目录的地址而 404。
  function modelBaseUrl(name) {
    const entry = modelsList.find(m => m.name === name);
    if (entry && entry.bundled) return '/live2d/models/' + encodeURIComponent(name) + '/';
    const base = window.__nativeModelBase ? window.__nativeModelBase : '/live2d/models/';
    return base + encodeURIComponent(name) + '/';
  }

  /**
   * 拼出模型内某个资源的完整 URL。
   * relPath 是「相对模型根目录」的路径，由 /api/live2d/models 返回，可能带子目录
   * （如 `motions/idle.motion3.json`、`exp/脸红.exp3.json`，也可能就是根目录下的
   * `脸红.exp3.json`）。
   *
   * 历史包袱：这里原来一律写成 `modelBaseUrl(name) + 'exp/' + 文件名`，即假定每个模型
   * 都把表情和动作放在 exp/ 子目录里。但这不是 Cubism 的规范，只是某几个模型的个人习惯——
   * 仓库内置的 deepseek 把 50 多个 *.exp3.json 直接堆在模型根目录、动作放在 motions/，
   * 于是它的表情/动作请求全部 404，表现出来就是"打包进去的模型没有表情"。
   * 现在改为按清单里的真实相对路径拼，exp/ 约定照样兼容。
   *
   * 注意逐段编码：整串 encodeURIComponent 会把路径分隔符也编成 %2F，服务端就找不到文件了。
   */
  function modelAssetUrl(name, relPath) {
    const rel = String(relPath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return modelBaseUrl(name) + rel;
  }

  async function deleteModel(name) {
    if (!name) return;
    if (!window.confirm('确定删除模型「' + name + '」？此操作不可恢复。')) return;
    try {
      const res = await fetch('/api/live2d/models/' + encodeURIComponent(name), { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        // 清理该模型保存的尺寸/位置与水印记忆
        try {
          LS.removeItem(L2D_PREFIX + 'resize.' + name);
          LS.removeItem(L2D_PREFIX + 'wm.' + name);
        } catch { /* ignore */ }
        if (selectedModel === name) selectedModel = '';
        await refreshModelList();
        if (isOpen) {
          if (modelsList.length) await loadModel();
          else {
            const tag = document.getElementById('live2d-name-tag');
            if (tag) tag.textContent = '未上传模型，请到「设置 → 插件 → Galgame 界面 → 情景演绎设置」上传 zip';
          }
        }
        return true;
      }
      window.alert('删除失败：' + (json.message || '未知错误'));
      return false;
    } catch (err) {
      window.alert('删除失败：' + (err.message || err));
      return false;
    }
  }

  // ===== 水印开关（通用探测，由 AI 通过 [操作:隐藏水印/显示水印] 控制，无手动按钮） =====
  // 很多免费 Live2D 模型（如 悠小喵/泠）内置"水印"部件，作者在 VTube Studio 里绑定数字键
  // （如 悠小喵=1、泠=0）触发一个"水印开关"表情（如 水印开关.exp3.json → Param85=1）来隐藏水印。
  // 这里通用探测：模型 exp 目录文件名含"水印/watermark"的表情即视为水印开关。

  async function detectWatermark(info) {
    watermarkExp = null;
    watermarkParamId = null;
    watermarkValue = 1;
    watermarkOn = false;
    if (!info || !Array.isArray(info.exps) || !info.exps.length) return;
    const hit = info.exps.find(f => /水印|watermark|wm开关|water_mark/i.test(f));
    if (!hit) return;
    watermarkExp = hit;
    // 读取表情内容，拿到它设置的参数 Id 与隐藏值（用于直接驱动参数，比 expression 播放更可靠）
    try {
      const res = await fetch(modelAssetUrl(selectedModel, hit));
      const json = await res.json();
      const p = json && Array.isArray(json.Parameters) ? json.Parameters[0] : null;
      if (p && p.Id) {
        watermarkParamId = p.Id;
        if (p.Value != null) watermarkValue = p.Value;
      }
    } catch { /* ignore */ }
    // 恢复上次记忆：该模型之前隐藏过水印（AI 触发后记忆，下次打开自动恢复隐藏）
    try {
      if (LS.getItem(L2D_PREFIX + 'wm.' + selectedModel) === '1') {
        watermarkOn = true;
        if (model) applyWatermark();
      }
    } catch { /* ignore */ }
  }

  // 按当前 watermarkOn 状态直接驱动参数（setParameterValueById 比 expression 播放更可靠）
  function applyWatermark() {
    if (!model || !watermarkExp) return;
    try {
      const coreModel = model.internalModel?.coreModel;
      if (watermarkParamId && coreModel && typeof coreModel.setParameterValueById === 'function') {
        coreModel.setParameterValueById(watermarkParamId, watermarkOn ? watermarkValue : 0);
        return;
      }
      // 兜底：无参数信息时用表情播放
      if (watermarkOn) {
        void model.expression(modelAssetUrl(selectedModel, watermarkExp));
      } else {
        void model.expression();
      }
    } catch (err) {
      console.warn('[Live2D] 水印开关应用失败:', err);
    }
  }

  async function toggleWatermark() {
    if (!model || !watermarkExp) return;
    watermarkOn = !watermarkOn;
    applyWatermark();
    try { LS.setItem(L2D_PREFIX + 'wm.' + selectedModel, watermarkOn ? '1' : '0'); } catch { /* ignore */ }
  }

  function onWatermarkKeyDown(e) {
    if (!isOpen || !watermarkExp) return;
    if (e.key === '1' || e.key === '0' || e.code === 'Digit1' || e.code === 'Digit0' || e.code === 'Numpad1' || e.code === 'Numpad0') {
      e.preventDefault();
      void toggleWatermark();
    }
  }

  // ===== 模型调整框（通话界面，开关按钮控制） =====
  let dragState = null; // 当前拖拽：{mode:'move'|'resize', dir, px, py, sx0, sy0, cx0, cy0, dist0}
  let adjustBoxVisible = false;

  function toggleAdjustBox() {
    adjustBoxVisible = !adjustBoxVisible;
    const box = document.getElementById('live2d-resize-box');
    const btn = document.getElementById('live2d-adjust-toggle');
    if (btn) btn.classList.toggle('active', adjustBoxVisible);
    if (box) box.classList.toggle('show', adjustBoxVisible);
    if (adjustBoxVisible) updateResizeBox();
  }

  // canvas 内部分辨率 → CSS 像素 的缩放因子（PIXI 世界坐标是内部像素，
  // 若与 CSS 尺寸不一致，直接用作 left/top 会偏移 → 乘该因子校正）
  function canvasPixelScale() {
    const canvas = document.getElementById('live2d-canvas');
    if (canvas && canvas.width > 0 && canvas.clientWidth > 0) {
      return canvas.clientWidth / canvas.width;
    }
    return 1;
  }

  function updateResizeBox() {
    const box = document.getElementById('live2d-resize-box');
    if (!box || !box.classList.contains('show')) return;
    if (!model || !app) return;
    let b;
    try { b = model.getBounds(); } catch { return; }
    if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.width) || !isFinite(b.height) || b.width <= 0 || b.height <= 0) return;
    const k = canvasPixelScale();
    box.style.left = (b.x * k) + 'px';
    box.style.top = (b.y * k) + 'px';
    box.style.width = (b.width * k) + 'px';
    box.style.height = (b.height * k) + 'px';
  }

  function resizeCenter() {
    // 模型中心：resizeState 存的是 canvas 内部像素比例，而鼠标事件 clientX/Y 是 CSS 像素，
    // 两者必须统一到 CSS 像素（canvasPixelScale 换算），否则分辨率不一致时拖拽会偏。
    const k = canvasPixelScale();
    return { x: resizeState.cx * app.screen.width * k, y: resizeState.cy * app.screen.height * k };
  }

  function startDrag(e, mode, dir) {
    if (!model || !app) return;
    dragState = {
      mode, dir,
      px: e.clientX, py: e.clientY,
      sx0: resizeState.sx, sy0: resizeState.sy,
      cx0: resizeState.cx, cy0: resizeState.cy,
    };
    const c = resizeCenter();
    dragState.dist0 = Math.max(1, Math.hypot(e.clientX - c.x, e.clientY - c.y));
    const box = document.getElementById('live2d-resize-box');
    if (box) box.classList.add('resizing');
    try { (e.target || box).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  function moveDrag(e) {
    if (!dragState || !model || !app) return;
    const st = dragState;
    const c = resizeCenter();
    if (st.mode === 'move') {
      const dx = (e.clientX - st.px) / app.screen.width;
      const dy = (e.clientY - st.py) / app.screen.height;
      resizeState.cx = Math.min(1, Math.max(0, st.cx0 + dx));
      resizeState.cy = Math.min(1, Math.max(0, st.cy0 + dy));
    } else {
      const dir = st.dir;
      const hasX = dir.indexOf('e') >= 0 || dir.indexOf('w') >= 0;
      const hasY = dir.indexOf('n') >= 0 || dir.indexOf('s') >= 0;
      const free = e.shiftKey; // Shift = 自由拉伸（角手柄）
      if (hasX && hasY && !free) {
        // 等比缩放：以拖拽起点到模型中心距离为基准，sx/sy 按同一比例变化
        const k = Math.max(0.01, Math.hypot(e.clientX - c.x, e.clientY - c.y) / st.dist0);
        resizeState.sx = clampScale(st.sx0 * k);
        resizeState.sy = clampScale(st.sy0 * k);
      } else {
        // 单轴拉伸（边手柄）或 Shift 自由拉伸（角手柄）
        if (hasX) {
          const baseX = Math.max(1, Math.abs(st.px - c.x));
          const curX = Math.max(1, Math.abs(e.clientX - c.x));
          resizeState.sx = clampScale(st.sx0 * (curX / baseX));
        }
        if (hasY) {
          const baseY = Math.max(1, Math.abs(st.py - c.y));
          const curY = Math.max(1, Math.abs(e.clientY - c.y));
          resizeState.sy = clampScale(st.sy0 * (curY / baseY));
        }
      }
    }
    applyModelSize();
    updateResizeBox();
  }

  function endDrag() {
    if (!dragState) return;
    dragState = null;
    const box = document.getElementById('live2d-resize-box');
    if (box) box.classList.remove('resizing');
    saveResizeState();
  }

  // ===== 渲染 =====
  /**
   * 确保 Live2D 引擎就绪。
   *
   * 2026-10 拆分后这里从"被动轮询"改成"**主动触发懒加载**"。
   *
   *   拆分前：三个库由 index.html 无条件 <script> 加载，所以只要轮询等它们挂上就行。
   *   拆分后：引擎住在 web/mods/live2d-models/vendor/ 里、**没人会自动加载它** ——
   *   如果这里还只是轮询，结果是等 8 秒然后报"库加载超时"，
   *   而真正的原因是"根本没人去取"。这是这次拆分最容易漏的一处。
   *
   *   现在：先问资源插件 ensureEngine()（它按 core → pixi → display 的顺序注入，
   *   并发调用只加载一次），拿到之后再做一次轮询兜底（防止 onload 与全局挂载之间有微小延迟）。
   */
  async function waitForLive2D(timeoutMs = 15000) {
    const engine = window.ElainaLive2DModels;
    if (engine && typeof engine.ensureEngine === 'function') {
      // 懒加载本身可能要下 770KB，所以这里的超时比原来宽松（8s → 15s）
      await engine.ensureEngine();
    }
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Live2D 引擎不可用（PIXI.live2d 未就绪）'));
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  async function open() {
    if (isOpen) return;
    // 立绘模式**不需要引擎**：先判断模式再等引擎，否则没装「Live2D 引擎与模型」
    //   时会被下面那段 alert 直接挡在门外 —— 而立绘本来就不依赖它。
    const needEngine = sceneMode !== 'portrait';
    if (needEngine) {
      // 确保 Live2D 引擎就绪（引擎已搬进 mod，这里负责触发按需加载）
      try {
        await waitForLive2D();
      } catch (err) {
        // 引擎起不来不该让整个舞台打不开：说清楚，并**降级到立绘模式**
        //   （用户至少还能看到角色与对话框），而不是弹一个框就什么都不给。
        console.error('[Live2D] PIXI.live2d 不可用:', window.PIXI ? Object.keys(window.PIXI) : 'PIXI 未加载');
        host.warn('Live2D 引擎未能加载，本次改用图片立绘：' + (err && err.message ? err.message : err));
        sceneMode = 'portrait';
        try { LS.setItem(SCENE_MODE_KEY, 'portrait'); } catch { /* ignore */ }
      }
    }
    isOpen = true;
    if (!container) buildUI();
    container = document.getElementById('live2d-call-host');
    container.classList.add('open');
    ensureMouseTracking();   // 每次打开都确保监听器在位（close 会移除）
    syncFollowHint();
    // 立绘 / 模型双模式：先把界面摆到用户选的那一套，再决定要不要加载引擎
    applySceneMode();
    // 气泡显示最新一句，并轮询后续消息（与剧情界面同一份数据）
    syncBubble(true);
    if (bubblePoll) clearInterval(bubblePoll);
    bubblePoll = setInterval(() => { if (isOpen) syncBubble(false); }, 700);

    // 立绘模式不需要引擎：直接跳过 PIXI 与模型加载（没装模型的用户也能用）。
    // 但**背景要先上**：它是 stage 的 CSS 背景，和用不用引擎无关。
    applyBackground();
    if (sceneMode === 'portrait') return;

    if (!app) {
      const canvas = document.getElementById('live2d-canvas');
      const wrap = document.getElementById('live2d-canvas-wrap');
      // 尺寸取 stage（立绘模式下画布容器是隐藏的，拿它当 resizeTo 会量到 0×0，
      // PIXI 会建出一个 1×1 的渲染器，切回模型时一片空白）
      const sizeTo = document.getElementById('live2d-stage') || wrap;
      app = new PIXI.Application({
        view: canvas,
        autoStart: true,
        resizeTo: sizeTo,
        background: 0x0b0e14,
        antialias: true,
      });
    }
    // 关闭通话时会停掉 PIXI 的 ticker（避免后台空转渲染），这里恢复
    try { app?.ticker?.start?.(); } catch { /* ignore */ }
    // 必须在 app 创建之后才应用背景：否则首次打开时渲染器还是不透明底色，
    // 会把设置里保存的自定义背景/图片整个盖住（app 已存在时重复调用是幂等的）
    applyBackground();
    await refreshModelList();
    if (modelsList.length) await loadModel();
    else {
      const tag = document.getElementById('live2d-name-tag');
      if (tag) tag.textContent = '未上传模型，请到「设置 → Live2D」上传 zip';
    }
    // 键盘快捷键：1 / 0 切换水印（仅通话打开时）
    if (!watermarkKeyHandler) {
      watermarkKeyHandler = onWatermarkKeyDown;
      window.addEventListener('keydown', watermarkKeyHandler);
    }
  }

  // 鼠标跟随开关（默认开启）
  let mouseFollowEnabled = (function () {
    try { return LS.getItem(L2D_PREFIX + 'mouseFollow') !== '0'; } catch { return true; }
  })();

  // 鼠标跟随幅度（设置 → Live2D）。
  // 同一个"转头"参数在不同模型上的实际幅度差别很大：把 ParamAngleX 驱动到 20，
  // 有的模型几乎不动，有的整张脸都转过去了。
  // 所以幅度做成可调倍率：
  //   滑块 0-10 是标准范围，10 = 原始幅度 = 1.0 倍（保持旧行为）；
  //   输入框可以填更大的数字解锁更高倍率，上限 100 = 10 倍。
  // ⚠️ 但头部幅度被模型自身参数量程锁死（实测两个内置模型的转头参数都是 ±30，
  //   基础值 20 已用掉 2/3 → ×1.5 就到顶）。所以 ×1.0 以上由"身体跟随"接手补足，
  //   否则数字框填再大也是空转。详见 mouseTrackTick 里的 bodyK。
  const MOUSE_SCALE_MAX = 100;   // 倍率上限（=10 倍幅度）
  const MOUSE_SCALE_BASE = 10;   // 滑块满格 = 1.0 倍
  const BODY_GAIN_SPAN = 2;      // 倍率从 ×1.0 到 ×3.0 期间，身体跟随从 0 加到满量程
  let mouseFollowScale = (function () {
    try {
      const raw = LS.getItem(L2D_PREFIX + 'mouseFollowScale');
      if (raw === null) return MOUSE_SCALE_BASE; // 老用户没有这项配置，保持原来的幅度
      const v = Number(raw);
      return Number.isFinite(v) ? Math.max(0, Math.min(MOUSE_SCALE_MAX, Math.round(v))) : MOUSE_SCALE_BASE;
    } catch { return MOUSE_SCALE_BASE; }
  })();

  // 把头部/眼球/身体参数复位到中位（关闭跟随、幅度归零、关闭通话三处共用）
  function resetFollowParams() {
    const cm = model?.internalModel?.coreModel;
    if (!cm || typeof cm.setParameterValueById !== 'function') return;
    for (const slot of ['headX', 'headY', 'eyeBallX', 'eyeBallY', 'bodyX', 'bodyY']) {
      for (const pid of resolveParamIds(slot)) {
        try { cm.setParameterValueById(pid, 0); } catch { /* ignore */ }
      }
    }
  }

  // 读某个参数的量程上限（绝对值）。驱动幅度不能超过它，否则 Cubism 会静默截断，
  // 用户会以为"倍率调高了却没反应"。
  // 带缓存：mouseTrackTick 每 33ms 调一次，而 Cubism 的 getParameterIndex 是线性查找。
  function paramAbsMax(cm, pid) {
    if (paramAbsMaxCache.has(pid)) return paramAbsMaxCache.get(pid);
    let v = 0;
    try {
      const idx = cm.getParameterIndex(pid);
      if (idx >= 0) v = Math.max(Math.abs(cm.getParameterMinimumValue(idx)), Math.abs(cm.getParameterMaximumValue(idx)));
    } catch { /* ignore */ }
    paramAbsMaxCache.set(pid, v);
    return v;
  }

  // 该模型上"头部还能不能再放大"：基础值 20 相对量程上限还剩多少余量。
  // 两个内置模型的转头参数都是 ±30 → ×1.0 就用掉 2/3，×1.5 之后到顶。
  function headSaturateK(cm) {
    let maxAbs = 0;
    for (const pid of resolveParamIds('headX')) maxAbs = Math.max(maxAbs, paramAbsMax(cm, pid));
    if (!maxAbs) return Infinity;      // 读不到量程就不限制（Cubism 自己会截断）
    return maxAbs / 20;                // ×N 的 N
  }

  function setMouseFollowScale(level) {
    const n = Number(level);
    mouseFollowScale = Number.isFinite(n)
      ? Math.max(0, Math.min(MOUSE_SCALE_MAX, Math.round(n)))
      : MOUSE_SCALE_BASE;
    try { LS.setItem(L2D_PREFIX + 'mouseFollowScale', String(mouseFollowScale)); } catch { /* ignore */ }
    // 幅度调到 0 等于"不跟随"，模型应立即回正，而不是停在上一帧歪着的角度
    if (mouseFollowScale === 0) {
      mouseTarget = { x: 0, y: 0 };
      mouseCurrent = { x: 0, y: 0 };
      resetFollowParams();
    } else {
      // 立刻按新倍率重算一帧。否则"鼠标不动、只改倍率"时模型会一直停在旧倍率的姿态：
      // mouseTrackTick 在插值稳定后就 clearInterval 了，没有鼠标事件不会再被触发。
      applyFollowDrive();
    }
    return mouseFollowScale;
  }

  function setMouseFollow(on) {
    mouseFollowEnabled = Boolean(on);
    try { LS.setItem(L2D_PREFIX + 'mouseFollow', mouseFollowEnabled ? '1' : '0'); } catch { /* ignore */ }
    if (!mouseFollowEnabled) {
      // 关闭时把目标与当前值都归零，并把模型的角度参数复位，避免停在歪着的位置
      mouseTarget = { x: 0, y: 0 };
      mouseCurrent = { x: 0, y: 0 };
      resetFollowParams();
    }
    syncFollowHint();
  }

  // 通话界面上提示"鼠标跟随已关闭"（关闭时模型不动，容易被误认为模型不支持跟随）
  function syncFollowHint() {
    const hint = document.getElementById('live2d-follow-hint');
    if (!hint) return;
    hint.classList.toggle('on', isOpen && !mouseFollowEnabled);
  }

  // 挂载/恢复鼠标追踪监听器（幂等）。
  // 必须每次 open() 都调用一次：close() 会移除监听器并置空，而 buildUI() 只执行一次，
  // 若只在 buildUI 里挂载，"关闭通话 → 再打开"之后鼠标跟随会永久失效。
  function ensureMouseTracking() {
    if (mouseMoveHandler) return;
    const stageEl = document.getElementById('live2d-stage');
    if (!stageEl) return;
    mouseMoveHandler = (e) => {
      if (!mouseFollowEnabled) return; // 设置里关掉了鼠标跟随
      if (dragState) return;           // 正在拖拽调整框时不要跟着转头
      const rect = stageEl.getBoundingClientRect();
      const w = rect.width || window.innerWidth || 1;
      const h = rect.height || window.innerHeight || 1;
      if (!w || !h) return;
      const nx = (e.clientX - rect.left) / w;
      const ny = (e.clientY - rect.top) / h;
      mouseTarget.x = Math.max(-1, Math.min(1, (nx - 0.5) * 2));
      mouseTarget.y = Math.max(-1, Math.min(1, (0.5 - ny) * 2));
      if (!mouseTrackRaf) mouseTrackRaf = setInterval(mouseTrackTick, 33);
    };
    // 监听整个通话层（不是只有画布）：鼠标移到顶栏/底栏附近时也能继续跟随
    stageEl.addEventListener('pointermove', mouseMoveHandler);
  }

  // 把当前 mouseCurrent 按当前倍率写进模型参数。
  // 单独抽出来是因为：mouseTrackTick 在插值稳定后会 clearInterval 停掉，
  // 此时若用户只改倍率而鼠标不动，就再没有任何东西会去重算 —— 模型会停在旧倍率的姿态上。
  function applyFollowDrive() {
    const coreModel = model?.internalModel?.coreModel;
    if (!coreModel || typeof coreModel.setParameterValueById !== 'function') return;
    // 幅度倍率：1 = 原始幅度（×1.0）。模型对参数的敏感度天生不同，靠这个系数拉平。
    const k = mouseFollowScale / MOUSE_SCALE_BASE;
    const x = mouseCurrent.x * k;
    const y = mouseCurrent.y * k;
    // 转头：驱动该模型所有真实存在的角度参数。
    // 不同作者会把同一个"转头"绑在 ParamAngleX 或 ParamAngleX1/Y1 上，
    // 只写标准名的话，遇到把标准名留空的模型就完全没反应（悠小喵就是这种）。
    // ⚠️ 这里不可能"无限放大"：参数值会被 Cubism 按模型自身量程截断。
    // 实测 LSS 的 ParamAngleX 与悠小喵的 ParamAngleX1 量程都是 ±30，
    // 基础值 20 已经用掉 2/3 → 倍率超过约 ×1.5 就没有任何视觉变化。
    // 想再往上只能靠下面的"身体跟随"，这也是数字框"解锁更高"的真正作用。
    for (const pid of resolveParamIds('headX')) coreModel.setParameterValueById(pid, x * 20);
    for (const pid of resolveParamIds('headY')) coreModel.setParameterValueById(pid, y * 16);
    // 眼球量程只有 ±1，所以：① 基准取 0.8（原 1.3 会让眼睛一动就顶到边界、永远贴着边）；
    // ② 倍率按平方根缓动，低倍率同步变灵敏、高倍率不会一动手就"眼睛贴边"。
    const eyeK = Math.sqrt(Math.max(k, 0));
    for (const pid of resolveParamIds('eyeBallX')) coreModel.setParameterValueById(pid, x * 0.8 * eyeK);
    for (const pid of resolveParamIds('eyeBallY')) coreModel.setParameterValueById(pid, y * 0.8 * eyeK);
    // 身体跟随：×1.0 时为 0（完全保持原行为），×3.0 时到达该模型身体参数的量程上限。
    // 头部到顶后由它继续把"幅度"补上去，否则"解锁更高倍率"在头部满量程后就是空转。
    const bodyK = Math.max(0, Math.min(1, (k - 1) / BODY_GAIN_SPAN));
    for (const pid of resolveParamIds('bodyX')) {
      const maxAbs = paramAbsMax(coreModel, pid) || 10;
      coreModel.setParameterValueById(pid, mouseCurrent.x * maxAbs * bodyK);
    }
    for (const pid of resolveParamIds('bodyY')) {
      const maxAbs = paramAbsMax(coreModel, pid) || 10;
      coreModel.setParameterValueById(pid, mouseCurrent.y * maxAbs * bodyK);
    }
  }

  // 鼠标追踪：平滑插值并驱动头部/眼球/身体参数（setInterval 驱动，兼容各种环境）
  function mouseTrackTick() {
    mouseCurrent.x += (mouseTarget.x - mouseCurrent.x) * 0.14;
    mouseCurrent.y += (mouseTarget.y - mouseCurrent.y) * 0.14;
    applyFollowDrive();
    const settled = Math.abs(mouseTarget.x - mouseCurrent.x) < 0.002 && Math.abs(mouseTarget.y - mouseCurrent.y) < 0.002;
    if (settled && mouseTrackRaf) { clearInterval(mouseTrackRaf); mouseTrackRaf = null; }
  }

  function close() {
    isOpen = false;
    speaking = false;
    if (bubblePoll) { clearInterval(bubblePoll); bubblePoll = null; }
    if (bubbleTyping) { clearInterval(bubbleTyping.timer); bubbleTyping = null; }
    // 退出舞台时把还没念完的语音停掉 —— 否则界面关了声音还在响
    try { if (typeof host.stopSpeech === 'function') host.stopSpeech(); } catch (e) { /* 忽略 */ }
    // 正在录音的话也停掉：界面都没了，麦克风不该还开着
    try {
      if (typeof host.dictationState === 'function') {
        const st = String(host.dictationState() || 'idle');
        if (st === 'listening' || st === 'paused') host.dictate('stop');
      }
    } catch (e) { /* 忽略 */ }
    speakStartedAt = 0;
    mouthEnergy = 1;
    voiceEnergy = null; // 必须复位：否则下次通话会沿用上一轮残留的真实音量，嘴型一开始就是张着的
    currentExpParams = [];
    if (container) container.classList.remove('open');
    adjustBoxVisible = false;
    dragState = null;
    const box = document.getElementById('live2d-resize-box');
    if (box) box.classList.remove('show', 'resizing');
    const btn = document.getElementById('live2d-adjust-toggle');
    if (btn) btn.classList.remove('active');
    if (watermarkKeyHandler) {
      window.removeEventListener('keydown', watermarkKeyHandler);
      watermarkKeyHandler = null;
    }
    // 移除鼠标追踪并复位参数
    if (mouseMoveHandler) {
      const stageEl = document.getElementById('live2d-stage');
      stageEl?.removeEventListener('pointermove', mouseMoveHandler);
      mouseMoveHandler = null;
    }
    syncFollowHint();
    if (mouseTrackRaf) { clearInterval(mouseTrackRaf); mouseTrackRaf = null; }
    // 停掉 PIXI 的 ticker：隐藏时没必要继续每帧渲染，open() 会重新 start
    try { app?.ticker?.stop?.(); } catch { /* ignore */ }
    mouseTarget = { x: 0, y: 0 };
    mouseCurrent = { x: 0, y: 0 };
    if (model) {
      // 复位同样按"该模型真实存在的角度参数"来，避免残留把头转着
      try { resetFollowParams(); } catch { /* ignore */ }
      try { model.internalModel?.coreModel?.setParameterValueById?.('ParamMouthOpenY', 0); } catch { /* ignore */ }
    }
  }

  // 并发保护：下拉切换、删除模型、open() 都可能同时触发加载。
  // 旧实现没有守卫：两次加载会各自 await，后完成的那次覆盖 model，
  // 而被覆盖的实例已经 addChild 但没人 destroy —— 双模型叠加渲染 + 显存泄漏。
  let modelLoadSeq = 0;

  async function loadModel() {
    if (!app || !selectedModel) return;
    const seq = ++modelLoadSeq;
    const tag = document.getElementById('live2d-name-tag');
    const info = getSelectedModelInfo();
    const modelName = selectedModel;
    const stale = () => seq !== modelLoadSeq; // 期间又来了新的加载请求
    modelAssetListKnown = false;              // 换模型期间清单未知，先回到回退行为
    try {
      if (!info || !info.modelJson) {
        if (tag) tag.textContent = '未在模型中找到 .model3.json';
        return;
      }
      const modelJsonPath = modelAssetUrl(modelName, info.modelJson);
      if (model) { try { app.stage.removeChild(model); model.destroy?.(); } catch { /* ignore */ } model = null; }
      // 等待 cubism4 核心就绪
      if (PIXI.live2d?.cubism4Ready) await PIXI.live2d.cubism4Ready;
      const created = await PIXI.live2d.Live2DModel.from(modelJsonPath, { autoInteract: false });
      if (stale()) { try { created.destroy?.(); } catch { /* ignore */ } return; }
      model = created;
      // 尽早记录当前模型可用表情/动作（供 AI 决策 + 语义映射兜底），避免后续步骤异常时丢失
      currentModelExps = Array.isArray(info.exps) ? info.exps.slice() : [];
      currentModelMotions = Array.isArray(info.motions) ? info.motions.slice() : [];
      modelAssetListKnown = true; // 清单已拿到：哪怕是空的，也能确定"这个模型没有表情文件"
      // 读取该模型的真实参数表（情绪参数按语义槽解析成真实参数名，换模型必须重算）
      refreshModelParamIds();
      // 尽早探测水印开关并恢复上次状态（不依赖 addChild 等后续步骤）
      await detectWatermark(info);
      if (stale()) return;
      // 确保 renderer 与容器尺寸一致（resizeTo 在首帧才生效）
      const wrap = document.getElementById('live2d-canvas-wrap');
      if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0) {
        app.renderer.resize(wrap.clientWidth, wrap.clientHeight);
      }
      // 图片网格交互：中心锚点，缩放以模型中心为基准
      model.anchor.set(0.5, 0.5);
      // 读取该模型的尺寸/位置记忆
      resizeState = loadResizeState();
      // 首次使用 / 旧版迁移：按屏幕高度比例换算初始缩放
      if (legacyScaleHint != null || needsInitScale) {
        const u = modelUnitBounds();
        if (u && u.h > 0) {
          const s = clampScale((app.screen.height * (legacyScaleHint != null ? legacyScaleHint : 0.65)) / u.h);
          resizeState.sx = s;
          resizeState.sy = s;
          legacyScaleHint = null;
          needsInitScale = false;
          saveResizeState();
        }
      }
      applyModelSize();
      app.stage.addChild(model);
      if (tag) tag.textContent = modelName;
      updateResizeBox();
      startRenderLoop();
      // 模型加载完成 → 同步提示词。
      //   必须放在这里而不是更早：currentModelExps / watermarkExp 是在上面
      //   （detectWatermark 与清单赋值）才填好的，早于它们同步就会注入
      //   "没有可用表情"的指南。换模型走同一个 loadModel，所以这里也天然覆盖了
      //   "换人后清单变了、提示词要跟着变"的情况。
      syncLive2DPromptHint();
      console.log('[Live2D] 模型加载成功:', modelName, modelJsonPath);
    } catch (err) {
      if (stale()) return;
      console.error('[Live2D] 模型加载失败:', err);
      if (tag) tag.textContent = '模型加载失败：' + (err.message || err);
    }
  }

  // ===== 渲染循环（嘴部动画 + 选择框跟随） =====
  function applyModelSize() {
    if (!model || !app) return;
    resizeState.sx = clampScale(resizeState.sx);
    resizeState.sy = clampScale(resizeState.sy);
    model.scale.set(resizeState.sx, resizeState.sy);
    model.position.set(resizeState.cx * app.screen.width, resizeState.cy * app.screen.height);
  }

  // ===== 背景 =====
  // 背景值最终会写进 CSS 的 background 属性，而它的来源包括 AI 的 [背景:xxx] 标签。
  // 不校验的话 `[背景:url(https://evil/?leak)]` 就能让浏览器主动去访问外部地址
  // （隐私泄漏 / 追踪信标）；`;` `}` 之类还能用来闭合声明注入别的样式。
  // 只放行：data: 图片、本服务内相对路径、渐变、纯色。
  function sanitizeBackground(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/[;{}]|expression\s*\(|javascript:|@import|<\/|\\/i.test(s)) return '';
    if (/^url\(\s*["']?data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+["']?\s*\)$/i.test(s)) return s;
    if (/^url\(\s*["']?\/?[\w./\-%\u4e00-\u9fa5]+["']?\s*\)$/i.test(s)) return s;
    if (/^linear-gradient\([^();{}]*\)$/i.test(s)) return s;
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
    if (/^rgba?\([\d\s.,%]+\)$/i.test(s)) return s;
    console.warn('[Live2D] 已忽略不受支持的背景值:', s.slice(0, 120));
    return '';
  }

  let bgStyle = (function () {
    try { return sanitizeBackground(LS.getItem(L2D_PREFIX + 'bg') || ''); } catch { return ''; }
  })();

  function applyBackground() {
    const stage = document.getElementById('live2d-stage');
    if (!stage) return;
    if (bgStyle.startsWith('url(') || bgStyle.startsWith('data:') || bgStyle.startsWith('linear-gradient') || bgStyle.startsWith('#') || bgStyle.startsWith('rgb')) {
      // 图片或渐变/纯色背景：画布透明，背景由 CSS 显示
      stage.style.background = bgStyle;
      stage.style.backgroundSize = 'cover';
      stage.style.backgroundPosition = 'center';
      if (app) app.renderer.background = 0x000000, app.renderer.backgroundAlpha = 0;
    } else {
      stage.style.background = 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)';
      stage.style.backgroundSize = '';
      if (app) app.renderer.background = 0x0b0e14, app.renderer.backgroundAlpha = 1;
    }
  }

  function startRenderLoop() {
    if (rafRunning || !model) return;
    rafRunning = true;
    const tick = () => {
      if (!isOpen || !model) { rafRunning = false; return; }
      // 保持 canvas 内部分辨率与容器 CSS 尺寸一致，避免模型被拉伸变形。
      // 量 stage 而不是 canvas-wrap：立绘模式下 canvas-wrap 是 display:none，
      // 量它得到 0×0，renderer 被缩成 1×1 —— 从立绘切回模型时就是一片空白。
      const wrap = document.getElementById('live2d-stage') || document.getElementById('live2d-canvas-wrap');
      if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0 &&
          (wrap.clientWidth !== app.screen.width || wrap.clientHeight !== app.screen.height)) {
        app.renderer.resize(wrap.clientWidth, wrap.clientHeight);
        applyModelSize();
      }
      // 注意：这里**不能**再调 app.ticker.update()。
      // PIXI Application 在 autoStart 下已经把自己的 ticker 跑在 rAF 上（其中就包含 renderer.render），
      // 这里再手动 update 一次，等于每帧把整棵场景重复渲染一遍（纯浪费）。
      // 待机动画/物理由 PIXI 自己的 ticker 推进，本循环只负责尺寸对齐、嘴型与调整框。
      if (speaking) updateMouth();
      if (!dragState) updateResizeBox();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function updateMouth() {
    let wave;
    if (voiceEnergy != null) {
      // 真实语音音量驱动（VAD）：音量 + 微抖动模拟自然说话节奏
      wave = (0.12 + 0.88 * voiceEnergy) * mouthEnergy + 0.06 * Math.sin(performance.now() / 45);
    } else {
      // 无真实音量时用正弦波模拟（原有行为）
      wave = (0.35 + 0.65 * Math.abs(Math.sin(performance.now() / 120))) * mouthEnergy;
    }
    const value = Math.min(1, Math.max(0.08, wave));
    try {
      model.internalModel?.coreModel?.setParameterValueById?.('ParamMouthOpenY', value);
    } catch { /* ignore */ }
  }

  function startMouth() {
    speaking = true;
  }

  function stopMouth() {
    speaking = false;
    mouthEnergy = 1;
    voiceEnergy = null;
    if (model) {
      try { model.internalModel?.coreModel?.setParameterValueById?.('ParamMouthOpenY', 0); } catch { /* ignore */ }
    }
  }

  // ===== 表情 / 动作 =====
  // 注意：pixi-live2d-display 的 model.expression() 播放 exp3 在本库版本下参数不生效
  // （水印修复时已证实）。因此这里读取 exp3.json 的 Parameters 直接驱动 coreModel 参数，更可靠。

  // 表情/动作同义词组：AI 输出的情绪词与模型实际文件名是近义词时也能匹配（跨模型自适应）
  const EXP_SYNONYM_GROUPS = [
    ['开心', '高兴', '喜悦', '快乐', '微笑', '笑', 'happy', 'smile', 'laugh'],
    ['难过', '伤心', '悲伤', '沮丧', '哭', 'sad', 'cry'],
    ['生气', '愤怒', '怒', '恼火', 'angry'],
    ['害羞', '脸红', '羞涩', 'blush', 'shy'],
    ['惊讶', '震惊', '吃惊', '吓', 'surprised', 'dizzy'],
    ['思考', '思索', '想', 'think'],
    ['平静', '常规', '默认', '普通', 'calm', 'normal', 'idle'],
    ['晕', '眩晕', 'dizzy'],
    ['委屈', '泪', 'cry'],
    ['挥手', '招', 'wave'],
    ['鞠躬', 'bow'],
  ];

  // 表情/动作名最终会被拼进 URL 路径。encodeURIComponent 不编码字符 '.'，
  // 所以 `[表情:../../x]` 这种输入必须在这里挡掉：Web 端还有"隐藏文件"规则兜底，
  // 但 Android（Capacitor）走本地文件系统，没有那层保护。
  function sanitizeAssetName(name) {
    const s = String(name || '').trim();
    if (!s) return '';
    if (s.includes('/') || s.includes('\\') || s.includes('..') || s.startsWith('.')) return '';
    return s;
  }

  // 在当前模型 exps/motions 里模糊匹配目标名（子串 → 同义词组）
  // 注意：双向 includes 在 target 只有 1 个字符时会命中任意文件名（"a" 命中 "脸a红"），
  // 因此要求两者的有效长度都 >= 2 再参与模糊匹配。
  // 清单里的元素是「相对模型根目录的路径」（可能带子目录），比较时只看文件名部分，
  // 返回时把完整相对路径带回去 —— 调用方要用它拼 URL。
  function fuzzyMatchFileName(target, files, ext) {
    const t = String(target || '').trim();
    if (t.length < 2) return null;
    const strip = (f) => f.replace(new RegExp('\\.' + ext + '\\.json$', 'i'), '');
    const baseNameOf = (f) => strip(f).split('/').pop();
    const usable = (base) => base.length >= 2;
    const hit1 = files.find(f => {
      const base = baseNameOf(f);
      return usable(base) && (base.includes(t) || t.includes(base));
    });
    if (hit1) return strip(hit1);
    const group = EXP_SYNONYM_GROUPS.find(g => g.some(w => t.includes(w) || w.includes(t)));
    if (group) {
      const hit2 = files.find(f => {
        const base = baseNameOf(f);
        return usable(base) && group.some(w => base.includes(w) || w.includes(base));
      });
      if (hit2) return strip(hit2);
    }
    return null;
  }

  // 把 AI 给的名称解析成当前模型实际存在的表情文件名（无扩展名）
  // 优先级：语义映射键（EXPRESSION_MAP）→ 精确文件名 → 模糊/同义词匹配 → 原样
  // 当前模型的表情/动作清单是否已经拿到。
  // 用于区分两种情况：①"还没加载出来/未知"（保持旧的回退行为）
  //                 ②"已经拿到，但模型根本没有 exp 目录"（此时任何表情名都必然 404，必须直接放弃）
  function resolveExpressionFile(name) {
    const raw = sanitizeAssetName(String(name || '').trim().replace(/\.(exp3|motion3)\.json$/i, ''));
    if (!raw) return '';
    const mapped = EXPRESSION_MAP[raw] || raw;
    if (!currentModelExps.length) {
      // 清单已知却为空 → 这个模型没有任何表情文件，别再发注定 404 的请求
      if (modelAssetListKnown) {
        console.warn('[Live2D] 当前模型没有表情文件，表情标签已忽略:', raw);
        return '';
      }
      return mapped; // 清单未知时保持原行为
    }
    // 清单元素是「相对模型根目录的路径」。先按整条路径比（调用方直接给路径时），
    // 再按文件名比（绝大多数情况：AI 只知道表情叫什么）。
    // 返回值同样是相对路径（去掉扩展名），调用方据此拼 URL —— 不能只返回文件名，
    // 否则子目录里的文件会拼错地址。
    const byPath = currentModelExps.find(f => f.replace(/\.exp3\.json$/i, '') === mapped);
    if (byPath) return byPath.replace(/\.exp3\.json$/i, '');
    const byBase = currentModelExps.find(f => f.split('/').pop().replace(/\.exp3\.json$/i, '') === mapped);
    if (byBase) return byBase.replace(/\.exp3\.json$/i, '');
    const fuzzy = fuzzyMatchFileName(mapped, currentModelExps, 'exp3');
    if (fuzzy) return fuzzy;
    // 明确匹配不到 → 返回空串让调用方跳过，不要再去 fetch 一个必然 404 的路径
    console.warn('[Live2D] 当前模型没有可用的表情文件:', raw, '（映射为', mapped + '）');
    return '';
  }

  function resolveMotionFile(name) {
    const raw = sanitizeAssetName(String(name || '').trim().replace(/\.(exp3|motion3)\.json$/i, ''));
    if (!raw) return '';
    const mapped = MOTION_MAP[raw] || raw;
    if (!currentModelMotions.length) {
      if (modelAssetListKnown) {
        console.warn('[Live2D] 当前模型没有动作文件，动作标签已忽略:', raw);
        return '';
      }
      return mapped; // 动作列表未知时保持原行为
    }
    const byPath = currentModelMotions.find(f => f.replace(/\.motion3\.json$/i, '') === mapped);
    if (byPath) return byPath.replace(/\.motion3\.json$/i, '');
    const byBase = currentModelMotions.find(f => f.split('/').pop().replace(/\.motion3\.json$/i, '') === mapped);
    if (byBase) return byBase.replace(/\.motion3\.json$/i, '');
    const fuzzy = fuzzyMatchFileName(mapped, currentModelMotions, 'motion3');
    if (fuzzy) return fuzzy;
    console.warn('[Live2D] 当前模型没有可用的动作文件:', raw, '（映射为', mapped + '）');
    return '';
  }

  let currentExpParams = []; // 当前表情驱动的参数 [{id, prev}]，切换时先复位避免叠加

  // 复位上一次表情设置的参数（恢复应用前原值）
  function resetExpressionParams(coreModel) {
    if (!coreModel || !currentExpParams.length) return;
    for (const p of currentExpParams) {
      try {
        coreModel.setParameterValueById(p.id, p.prev !== undefined ? p.prev : 0);
      } catch { /* ignore */ }
    }
    currentExpParams = [];
  }

  // 表情切换的并发保护：driveText 是"即发即忘"地调用它，而内部含 fetch/await。
  // 连续两次回复（或流式分片）会让两次调用交错：后一次的 resetExpressionParams 会清掉
  // 前一次刚写进去的参数，表现为"表情切了但脸还停在上一张"。用自增序号保证只有最后一次生效。
  let expressionSeq = 0;

  async function setExpression(name) {
    const target = model;
    if (!target) return false;
    const seq = ++expressionSeq;
    const modelName = selectedModel;
    const raw = String(name || '').trim().replace(/\.(exp3|motion3)\.json$/i, '');
    // 复位表情：[表情:default] / [表情:常规] / [表情:reset] → 恢复所有参数
    if (/^(default|none|reset|clear|常规|默认|正常)$/i.test(raw)) {
      if (seq !== expressionSeq) return false;
      resetExpressionParams(target.internalModel?.coreModel);
      currentExpression = null;
      console.log('[Live2D] 表情已复位');
      return true;
    }
    const expName = resolveExpressionFile(raw);
    if (!expName) {
      // 没有匹配的表情文件：复位上一个表情的参数，避免"换了情绪但脸还停在上一张"
      if (seq !== expressionSeq) return false;
      resetExpressionParams(target.internalModel?.coreModel);
      currentExpression = null;
      return false;
    }
    try {
      const url = modelAssetUrl(modelName, expName + '.exp3.json');
      const res = await fetch(url);
      if (seq !== expressionSeq) return false; // 已有更新的表情请求，丢弃这次结果
      if (res.ok) {
        const json = await res.json();
        if (seq !== expressionSeq) return false;
        const params = json && Array.isArray(json.Parameters) ? json.Parameters : null;
        const coreModel = target.internalModel?.coreModel;
        if (params && params.length && coreModel && typeof coreModel.setParameterValueById === 'function') {
          // 关键：先复位上一个表情的参数，再应用新表情，避免参数叠加导致"切换不成功"
          resetExpressionParams(coreModel);
          const applied = [];
          for (const p of params) {
            const pid = p?.Id;
            if (!pid) continue;
            const value = Number(p.Value ?? 0);
            const blend = String(p.Blend || 'Overwrite');
            const cur = typeof coreModel.getParameterValueById === 'function' ? Number(coreModel.getParameterValueById(pid) || 0) : 0;
            let next;
            if (blend === 'Multiply') next = cur * value;
            else if (blend === 'Add') next = cur + value;
            else next = value;
            coreModel.setParameterValueById(pid, Math.max(-1, Math.min(1, next)));
            applied.push({ id: pid, prev: cur });
          }
          currentExpParams = applied;
          currentExpression = raw;
          console.log('[Live2D] 表情:', expName, '(直接驱动参数)');
          return true;
        }
      }
      // 兜底：无参数信息或 coreModel 不可用时退回库的 expression
      await target.expression(url);
      if (seq !== expressionSeq) return false;
      currentExpression = raw;
      return true;
    } catch (err) {
      console.warn('[Live2D] 表情触发失败:', expName, err);
      return false;
    }
  }

  async function playMotion(name) {
    const target = model;
    if (!target) return;
    const motionName = resolveMotionFile(name);
    if (!motionName) return;
    const modelName = selectedModel;
    try {
      await target.motion(modelAssetUrl(modelName, motionName + '.motion3.json'));
      if (model !== target) return; // 期间换了模型，这次动作结果作废
      console.log('[Live2D] 动作:', motionName);
    } catch (err) {
      console.warn('[Live2D] 动作触发失败:', motionName, err);
    }
  }

  function cycleExpression() {
    const keys = Object.keys(EXPRESSION_MAP);
    const idx = keys.indexOf(currentExpression);
    const next = keys[(idx + 1) % keys.length];
    void setExpression(next);
  }

  // ===== 情绪系统：LLM 通过 [情绪:xxx] 或触发词驱动 =====
  // ⚠️ 重要前提：不同模型的参数命名并不统一，而 Cubism 运行时对**不存在的参数名不报错**——
  // setParameterValueById 会静默接受、getParameterValueById 还能读回刚写的值，但该参数没有任何
  // 绘制绑定，画面完全不变。这类"看起来生效、实际零效果"的问题极难发现，因此这里一律：
  //   ① 先取模型真实参数表 → ② 按语义槽解析真实参数名 → ③ 解析不到就跳过并告警，绝不硬写。
  // 例：悠小喵没有 ParamSmile/ParamCheek/ParamBrowL/ParamEyeLOpening，
  //     用的是 ParamEyeLSmile/ParamCheekPuff/ParamBrowLY/ParamEyeLOpen。
  let currentModelParamIds = new Set();
  const resolvedParamListCache = new Map();
  const paramAbsMaxCache = new Map();   // 参数名 → 量程上限（绝对值），换模型时清空

  // 语义槽 → 候选参数名（按优先级，覆盖常见命名习惯）
  // smile 把 ParamMouthForm 排在眼睛笑意之前：嘴型是"笑"最直接的可见线索，
  // 而且不少模型（如悠小喵）根本没绑定 ParamEyeLSmile，只绑了 ParamMouthForm。
  const PARAM_CANDIDATES = {
    smile: ['ParamSmile', 'ParamMouthForm', 'ParamEyeLSmile', 'ParamEyeRSmile'],
    cheek: ['ParamCheek', 'ParamCheekPuff'],
    browL: ['ParamBrowL', 'ParamBrowLY', 'ParamBrowLForm'],
    browR: ['ParamBrowR', 'ParamBrowRY', 'ParamBrowRForm'],
    eyeL: ['ParamEyeLOpening', 'ParamEyeLOpen'],
    eyeR: ['ParamEyeROpening', 'ParamEyeROpen'],
    mouth: ['ParamMouthOpenY', 'ParamMouthOpen'],
    // 转头/眼球：很多模型把标准名 ParamAngleX/Y 留空，真正的绑定在 ParamAngleX1/Y1 上，
    // 所以这两槽驱动"所有真实存在的候选"而不是只取第一个。
    // ⚠️ 只收 标准名 和 1 号变体，不要 X2/Y2：
    // 实测悠小喵的 ParamAngleY2 并不是"低头/抬头"，设它会让整个模型（连水印层）一起下沉前倾，
    // 看起来像模型朝鼠标扑过来，非常突兀。带 2 的变体在不同模型里可能是整体位移/整体旋转，
    // 语义不可靠，宁可不驱动。
    headX: ['ParamAngleX', 'ParamAngleX1'],
    headY: ['ParamAngleY', 'ParamAngleY1'],
    eyeBallX: ['ParamEyeBallX'],
    eyeBallY: ['ParamEyeBallY'],
    // 身体角度：只在"头部已经到量程上限"之后才介入（见 mouseTrackTick）。
    // 头部的转动幅度被模型自身的参数上限锁死（实测 LSS 与悠小喵的转头参数都是 ±30，
    // 基础值 20 已经用掉三分之二），所以倍率超过约 ×1.5 就完全没有效果了。
    // 想让"解锁更高倍率"真的产生变化，只能在头部满量程后带动身体一起转。
    bodyX: ['ParamBodyAngleX', 'ParamBodyAngleX1'],
    bodyY: ['ParamBodyAngleY', 'ParamBodyAngleY1'],
  };
  // 兜底关键字（精确候选名都没命中时，按语义在参数表里模糊找）
  const PARAM_KEYWORDS = {
    smile: /smile/i, cheek: /cheek/i,
    browL: /^parambrowl/i, browR: /^parambrowr/i,
    eyeL: /^parameyel.*open/i, eyeR: /^parameyer.*open/i,
    mouth: /^parammouth.*open/i,
    headX: /^paramanglex/i, headY: /^paramangley/i,
    eyeBallX: /^parameyeballx/i, eyeBallY: /^parameybally/i,
    bodyX: /^parambodyanglex/i, bodyY: /^parambodyangley/i,
  };
  // 需要"驱动所有存在的候选"的槽（模型可能把同一动作拆到多个参数上）
  const MULTI_PARAM_SLOTS = new Set(['headX', 'headY', 'eyeBallX', 'eyeBallY', 'bodyX', 'bodyY']);

  // 读取当前模型真实参数表（换模型后必须重算）
  function refreshModelParamIds() {
    currentModelParamIds = new Set();
    resolvedParamListCache.clear();
    paramAbsMaxCache.clear();   // 换了模型，量程缓存必须作废
    try {
      const core = model?.internalModel?.coreModel;
      if (!core) return;
      if (Array.isArray(core._parameterIds)) {
        for (const id of core._parameterIds) currentModelParamIds.add(String(id));
      } else if (core._parameterIds && core._parameterIds._ptr) {
        // Cubism 的 csmVector 内部是 _ptr 数组
        for (const id of Array.prototype.slice.call(core._parameterIds._ptr)) currentModelParamIds.add(String(id));
      } else if (typeof core.getParameterCount === 'function' && typeof core.getParameterId === 'function') {
        for (let i = 0; i < core.getParameterCount(); i++) {
          const id = core.getParameterId(i);
          if (id) currentModelParamIds.add(String(id));
        }
      }
    } catch { /* ignore */ }
    console.log('[Live2D] 模型参数表:', currentModelParamIds.size, '个');
  }

  // 把语义槽解析成该模型真实存在的参数名列表；解析不到返回 []（调用方跳过，绝不硬写）
  function resolveParamIds(slot) {
    if (resolvedParamListCache.has(slot)) return resolvedParamListCache.get(slot);
    let list = [];
    if (currentModelParamIds.size) {
      const cands = PARAM_CANDIDATES[slot] || [];
      const hit = cands.filter(id => currentModelParamIds.has(id));
      list = MULTI_PARAM_SLOTS.has(slot) ? hit : hit.slice(0, 1);
      if (!list.length) {
        const kw = PARAM_KEYWORDS[slot];
        if (kw) {
          for (const id of currentModelParamIds) { if (kw.test(id)) { list = [id]; break; } }
        }
      }
    }
    resolvedParamListCache.set(slot, list);
    return list;
  }

  // 单值槽：取第一个（表情/情绪参数组用）
  function resolveParamId(slot) { return resolveParamIds(slot)[0] || ''; }

  // FACS 简化：情绪 → 语义参数槽（不写死参数名，由 resolveParamId 落地到真实参数）
  const EMOTION_PARAM_SETS = {
    happy: { smile: 0.9, eyeL: 1.15, eyeR: 1.15, cheek: 0.6 },
    sad: { browL: -0.35, browR: -0.35, eyeL: 0.45, eyeR: 0.45, mouth: 0.2 },
    angry: { browL: -0.9, browR: -0.9, eyeL: 0.75, eyeR: 0.75, mouth: 0.4 },
    shy: { cheek: 0.9, smile: 0.5, eyeL: 0.6, eyeR: 0.6 },
    surprised: { browL: 0.6, browR: 0.6, eyeL: 1.5, eyeR: 1.5, mouth: 0.8 },
    cry: { browL: -0.6, browR: -0.6, eyeL: 0.5, eyeR: 0.5, mouth: 0.3 },
    think: { browL: 0.5, browR: -0.5, eyeL: 0.6, eyeR: 0.6 },
    dizzy: { eyeL: 0.3, eyeR: 0.3, mouth: 0.5 },
    calm: { smile: 0.3 },
  };

  // 把情绪参数组叠加到当前模型（在 exp 表情应用完成后再调用，避免被复位清掉）
  function applyEmotionParams(emotionKey) {
    const set = EMOTION_PARAM_SETS[emotionKey];
    if (!set) return;
    const cm = model?.internalModel?.coreModel;
    if (!cm || typeof cm.setParameterValueById !== 'function') return;
    const applied = [];
    const missing = [];
    for (const [slot, val] of Object.entries(set)) {
      const pid = resolveParamId(slot);
      if (!pid) { missing.push(slot); continue; }
      const prev = typeof cm.getParameterValueById === 'function' ? Number(cm.getParameterValueById(pid) || 0) : 0;
      try { cm.setParameterValueById(pid, Math.max(-1, Math.min(1.5, Number(val)))); } catch { continue; }
      applied.push({ id: pid, prev });
    }
    if (applied.length) currentExpParams.push(...applied);
    if (missing.length) console.warn('[Live2D] 该模型没有这些情绪参数槽，已跳过：', missing.join(', '));
  }

  /**
   * 把一个情绪/表情词解析成内部情绪键（happy/sad/…）。
   *
   * 两处共用（`[情绪:]` 与立绘模式下的 `[表情:]`），免得同一套同义词表写两遍。
   * @returns {{key:string, emo:object}|null}
   */
  function resolveEmotionKey(name) {
    const input = String(name || '').trim();
    if (!input) return null;
    const lower = input.toLowerCase();
    if (EMOTION_MAP[lower]) return { key: lower, emo: EMOTION_MAP[lower] };
    for (const [k, v] of Object.entries(EMOTION_MAP)) {
      if (k === input || v.exp === input || v.keys.some(w => w === input)) return { key: k, emo: v };
    }
    return null;
  }

  function driveEmotion(name) {
    const hit = resolveEmotionKey(name);
    if (!hit) {
      console.warn('[Live2D] 未知情绪:', name);
      return false;
    }
    mouthEnergy = hit.emo.energy;
    // 立绘模式：情绪直接换立绘图，**不再碰模型**（模型根本没加载）
    if (sceneMode === 'portrait') {
      applyPortraitEmotion(hit.key);
      return true;
    }
    // 关键：参数组按「情绪键」查（happy/sad/surprised/calm…），不能按 exp 文件名键查。
    // 否则 surprised 的 exp 是 dizzy 会错套"晕"的参数组、calm 的 exp 是 smile 会直接查不到。
    void setExpression(hit.emo.exp).then(() => applyEmotionParams(hit.key));
    console.log('[Live2D] 情绪:', name, '→', hit.key, '(exp:', hit.emo.exp + ')', 'energy', hit.emo.energy);
    return true;
  }

  // 自动情绪推断：文本含触发词/emoji 时推断情绪（无显式标签时兜底）
  function inferEmotionFromText(text) {
    if (!text) return null;
    const t = String(text);
    for (const [key, v] of Object.entries(EMOTION_MAP)) {
      for (const w of v.keys) {
        if (t.includes(w)) return key;
      }
    }
    return null;
  }

  // 位置标签：[位置:left|center|right|上|中|下] —— 临时移动，不覆盖用户记忆
  function setModelPositionByTag(v) {
    const val = String(v || '').trim();
    if (val === 'left' || val === '左') resizeState.cx = 0.25;
    else if (val === 'right' || val === '右') resizeState.cx = 0.75;
    else if (val === 'center' || val === '中' || val === '中间') resizeState.cx = 0.5;
    else if (val === 'top' || val === '上') resizeState.cy = 0.25;
    else if (val === 'bottom' || val === '下') resizeState.cy = 0.85;
    else return;
    applyModelSize();
  }

  // 大小标签：[大小:大|小|特大|特小|65%] —— 临时缩放，不覆盖用户记忆
  function setModelSizeByTag(v) {
    const val = String(v || '').trim();
    let factor = null;
    if (val === '特大' || val === 'huge') factor = 1.5;
    else if (val === '大' || val === 'big' || val === 'large') factor = 1.2;
    else if (val === '小' || val === 'small') factor = 0.8;
    else if (val === '特小' || val === 'tiny') factor = 0.6;
    else if (/^\d+(\.\d+)?%$/.test(val)) {
      const u = modelUnitBounds();
      if (u && u.h > 0 && app) {
        const target = clampScale((parseFloat(val) / 100) * app.screen.height / u.h);
        factor = target / resizeState.sx;
      }
    }
    if (factor) {
      resizeState.sx = clampScale(resizeState.sx * factor);
      resizeState.sy = clampScale(resizeState.sy * factor);
      applyModelSize();
    }
  }

  // 背景预设名 → 值（供 AI 的 [背景:xxx] 标签切换）。
  // 设置界面里的渐变/纯色色块已移除，但这份映射要留：它是**标签协议**的一部分，AI 仍可用 [背景:深蓝] 换色。
  //   界面上没有 ≠ 能力上没有；色块只是「手动选」的入口。选现成的图（[背景:雪夜]）会先经场景背景资源包匹配。
  const BG_PRESETS = {
    '深蓝': 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)',
    '蓝紫': 'linear-gradient(135deg,#2b5876,#4e4376)',
    '星空': 'linear-gradient(135deg,#0f0c29,#302b63,#24243e)',
    '紫罗兰': 'linear-gradient(135deg,#8e2de2,#4a00e0)',
    '红蓝': 'linear-gradient(135deg,#fc466b,#3f5efb)',
    '深黑': '#0b0e14',
    '墨蓝': '#1a1a2e',
    '深紫': '#533483',
    '玫红': '#e94560',
    '青绿': '#0e8388',
  };

  /**
   * 把 [背景:xxx] 的值解析成真正能用的 CSS。
   *
   * 顺序很关键：**先问场景背景资源包**，再落到预设色。
   *   为什么先问资源包：现在有 31 张真图，AI 说 [背景:雪夜] 时用户的期待是
   *   "换成雪夜那张图"，而不是"换成某个颜色的渐变"。资源包认不出才回落到色值。
   *   资源包没装时 pick() 不存在，这段直接跳过 —— 纯色仍然可用（降级可用）。
   */
  function resolveBackgroundValue(name) {
    const key = String(name || '').trim();
    if (!key) return '';
    const sb = window.ElainaSceneBackgrounds;
    if (sb && typeof sb.pick === 'function') {
      try {
        const hit = sb.pick(key);
        if (hit && hit.url) return 'url(' + hit.url + ')';
      } catch (e) { /* 资源包出错不该影响换背景 */ }
    }
    return BG_PRESETS[key] || key;
  }

  /**
   * 舞台背景现在可用的名字（给提示词与设置页共用）。
   *
   * 两类：预设色（[背景:深蓝]）与场景图（[背景:雪夜]，来自 scene-backgrounds）。
   * 返回的是**名字**而不是 CSS —— AI 需要知道"能说什么"，不需要知道怎么实现。
   */
  function listBackgroundNames() {
    const scenes = [];
    const sb = window.ElainaSceneBackgrounds;
    if (sb && typeof sb.list === 'function') {
      try {
        for (const s of sb.list()) {
          const label = s && (s.label || s.file);
          if (label) scenes.push(label);
        }
      } catch (e) { /* 资源包不在就没图可选 */ }
    }
    return { presets: Object.keys(BG_PRESETS), scenes };
  }

  // ── Live2D 独有的两个操作：水印 / 静音 ──────────────────────────────────
  // 它们只有 Live2D 知道怎么执行（要动模型参数、要静 TTS），
  // 所以注册进宿主的操作分发链 —— 而不是像旧实现那样由本文件持有整条链。
  // 判据刻意跟"宿主不认识的未知操作"划清界限：宿主先问扩展处理器，
  // 都不认才轮到它自己的分支，最后才 warn「未知操作」。
  if (window.ElainaTags && typeof window.ElainaTags.registerOperationHandler === 'function') {
    window.ElainaTags.registerOperationHandler(
      (v) => /隐藏水印|去掉水印|水印隐藏|去水印/.test(v) || /显示水印|恢复水印|水印显示/.test(v),
      (v) => {
        if (/隐藏水印|去掉水印|水印隐藏|去水印/.test(v)) { if (!watermarkOn) void toggleWatermark(); return; }
        if (watermarkOn) void toggleWatermark();
      }
    );
    window.ElainaTags.registerOperationHandler(
      (v) => (/静音|静音AI/.test(v) && !/取消|解除/.test(v)) || /取消静音|解除静音|打开声音|恢复声音/.test(v),
      (v) => {
        if (/取消静音|解除静音|打开声音|恢复声音/.test(v)) { if (aiVoiceMuted) toggleMute(); return; }
        if (!aiVoiceMuted) toggleMute();
      }
    );
  } else {
    // 宿主标签模块没加载（不该发生：它在 app-* 里先于本文件）。
    // 明确记一笔，免得"AI 说隐藏水印但没反应"变成无从排查的问题。
    console.warn('[Live2D] ElainaTags 不可用，水印/静音操作将无法通过标签触发');
  }

  // 表现类标签的**说明书**：由本插件注入 system 提示词（不再由宿主无条件注入 ——
  //   否则纯净版（一个插件都没装）也会收到一份 Live2D 说明书，教模型输出根本没东西执行的标签）。
  //   宿主不知道有哪些插件、插件也不知道宿主怎么拼提示词，host.setPromptHint 是唯一耦合点；
  //   停用插件时这段提示词会被自动摘掉（见 mods.js 的 ensurePromptHintContribution）。
  //   留在宿主的只有「宿主自己就能执行」的几个（见 HOST_ACTION_TAG_GUIDE）：视频通话 / 整理记忆 / [任务:]。
  // 本提示词随**模型**变化（表情/动作清单、有无水印），所以每次模型加载/切换后都要重新同步一次。
  const LIVE2D_PRESENTATION_GUIDE = `# Agent Skill：Live2D 表现与状态控制
你在与用户进行角色扮演互动时，应当根据当前情景和情绪，在回复中自然使用以下标签来驱动角色的 Live2D 表情与动作（这些标签会被系统识别并执行，不会显示给用户，禁止在标签外使用方括号）：

【情绪标签（最常用，请优先使用）】[情绪:开心] / [情绪:难过] / [情绪:生气] / [情绪:害羞] / [情绪:惊讶] / [情绪:委屈] / [情绪:思考] / [情绪:平静] —— 触发对应表情与说话语气。
【表情标签】[表情:happy] / [表情:sad] / [表情:angry] / [表情:blush] / [表情:cry] / [表情:smile] / [表情:think] / [表情:shy] / [表情:dizzy] —— 直接指定表情。
【动作标签】[动作:wave]（挥手）/ [动作:bow]（鞠躬）。
【状态标签】[位置:left|center|right|上|下] —— 移动角色位置；[大小:大|小|特大|特小|65%] —— 调整角色大小。
【背景标签】[背景:深蓝|蓝紫|星空|紫罗兰|红蓝|深黑|墨蓝|深紫|玫红|青绿] —— 切换舞台背景。
【静音与水印】[操作:静音] / [操作:取消静音] / [操作:隐藏水印] / [操作:显示水印]

【使用要求】情绪标签是角色扮演表达的核心部分：每条回复都应根据内容带 1 个情绪或表情标签（内容完全中性时除外）；当情绪发生变化时（如从开心转为难过、从平静转为惊讶），务必切换到对应的情绪/表情标签，让角色的表情跟随情景变化；标签放在回复开头或情绪表达处，一条回复最多 2 个。`;

  /**
   * 把清单里「相对模型根目录的路径」剥成 AI 认识的名字。
   *
   * 抽成独立函数（不再只藏在 window.Live2DCall.getAvailableExpressions 里）的原因：
   *   **提示词注入**与**对外查询接口**现在都要用它，两处各写一份迟早会走样
   *   （历史上这个项目就吃过"同一份逻辑写两遍、改漏一处"的亏）。
   *   AI 该说"脸红"，而不是"exp/脸红.exp3.json"；同名去重，避免提示词里出现重复项。
   */
  function l2dExpressionNames(list, ext) {
    const out = [];
    for (const f of list) {
      const base = String(f).split('/').pop().replace(new RegExp('\\.' + ext + '\\.json$', 'i'), '');
      if (base && !out.includes(base)) out.push(base);
    }
    return out;
  }

  /** 当前模型的可用表现名字清单（表情 / 动作） */
  function l2dModelCapNames() {
    return {
      exps: l2dExpressionNames(currentModelExps, 'exp3'),
      motions: l2dExpressionNames(currentModelMotions, 'motion3'),
    };
  }

  /**
   * 组装并同步本插件要注入的 system 提示词。
   *
   * 三段拼接（都是 Live2D 自己的事）：
   *   ① 静态表现指南（上面那个常量）
   *   ② 当前模型**真实**可用的表情/动作文件名 —— 让 AI 直接选用真实文件名，
   *      跨模型自适应（换模型后清单不同，这里每次重算）
   *   ③ 仅当当前模型确实带水印开关时才追加水印提示（没有就别提，免得 AI 去输出
   *      一个不会有任何效果的 [操作:隐藏水印]）
   *
   * 必须在**模型加载完成之后**调用：②③ 依赖 currentModelExps / watermarkExp，
   *   在 loadModel() 之前它们还是空的 —— 那样注入的就是一份"没有可用表情"的
   *   指南，AI 只能退回 [情绪:…] 通用匹配（不致命，但白白浪费了模型自带的清单）。
   */
  /** 供 galgame 拼提示词时取用的"表现指南"（模型相关的那部分） */
  let sessionL2dHintProvider = null;
  function syncLive2DPromptHint() {
    try {
      const parts = [LIVE2D_PRESENTATION_GUIDE];
      const caps = l2dModelCapNames();
      if (caps.exps.length || caps.motions.length) {
        const lines = [];
        if (caps.exps.length) lines.push('可用表情（文件名）：' + caps.exps.join('、'));
        if (caps.motions.length) lines.push('可用动作（文件名）：' + caps.motions.join('、'));
        parts.push(`# 当前 Live2D 模型的可用表现（随模型变化，请根据情景从中选择最合适的）
${lines.join('\n')}
用法：用 [表情:文件名] 或 [动作:文件名] 标签直接选用上面的文件名（例如 [表情:${caps.exps[0] || '常规'}]）。每条回复带 1 个表情标签表达当前情绪；情绪变化时切换表情（系统会自动复位上一个表情，直接给新文件名即可）。若上面列表为空或都不合适，可用 [情绪:开心|难过|生气|害羞|惊讶|委屈|思考|平静] 由系统自动匹配。`);
      }
      if (watermarkExp) {
        parts.push('当前 Live2D 模型带有作者水印（模型内置水印开关）。请在开场白或合适的时机用 [操作:隐藏水印] 隐藏水印（标签不会显示给用户）；若用户明确要求查看原始水印，再用 [操作:显示水印]。');
      }
      // 背景：把"能说什么"直接列出来（两类名字），AI 才不会编不存在的场景。
      const bgs = listBackgroundNames();
      parts.push('# 舞台背景（[背景:名字]，立绘与模型两种呈现都生效）\n'
        + '预设色：' + bgs.presets.join('、') + '\n'
        + (bgs.scenes.length ? '场景图：' + bgs.scenes.join('、') + '\n' : '场景图：当前没有安装「场景背景图」\n')
        + '用法：在回复里写 [背景:深蓝] 或 [背景:雪夜]；只换背景时也放在回复末尾，标签不会显示给用户。');
      // 当前呈现方式：告诉 AI 哪些标签在这种情况下有效，避免在立绘模式下写动作/位置。
      parts.push(sceneMode === 'portrait'
        ? '# 当前呈现：图片立绘\n[情绪:…] 与 [表情:…] 都会切换立绘；[动作:] / [位置:] / [大小:] 在立绘模式下不适用，不要用。'
        : '# 当前呈现：Live2D 模型\n[情绪:] / [表情:] / [动作:] / [位置:] / [大小:] 都可用。');
      // 合并后由 galgame 的 syncSceneHint 统一注入（两段提示词合并成一份）。
      // 这里只交出手上的材料 —— 删掉两行都不行：
      //   ① 交出去 → 让 scene hint 能带上"当前模型有哪些表情/动作"
      //   ② 本处调用 → 已去掉，否则同一插件两次 setPromptHint 会互相覆盖
      sessionL2dHintProvider = () => parts.join('\n\n');
    } catch (e) {
      // 提示词注入失败不该影响通话本身 —— 顶多 AI 少知道几个标签名
      host.warn('同步表现提示词失败', e);
    }
  }

  // 取同类标签里最后一个。
  // 旧实现用非全局正则 match()，一条回复里出现两个同类标签时只有第一个被处理
  // （[操作:] 在修 8.7 时已改成全局，其它标签没跟上，导致行为不一致）。
  // 统一为"最后一个生效"：既不会漏，也避免同类标签重复触发请求造成并发竞态。
  function lastTagValue(text, name) {
    const re = new RegExp('\\[' + name + '[:：]\\s*([^\\]]+)\\]', 'g');
    let v = null, m;
    while ((m = re.exec(text)) !== null) v = m[1].trim();
    return v;
  }

  /**
   * 只驱动**表现**：表情 / 动作 / 情绪 / 位置 / 大小 / 背景。
   *
   * 与旧 driveText 的区别（解耦的核心）：
   *   旧函数末尾会遍历 [操作:…] 标签并调 handleAgentOperation —— 那是宿主的事。
   *   现在操作标签由 ElainaTags.drive 先分发，发完了才把文本交到这里做表现。
   *   所以本函数**不再碰** [操作:]，Live2D 卸掉也不会影响 Agent 能力。
   */
  function drivePresentation(text) {
    if (!text) return;
    const t = String(text);

    const expName = lastTagValue(t, '表情');
    if (expName) {
      // 立绘模式没有 exp3 文件：把表情名按同一套同义词表映射成立绘情绪
      //   （AI 写 [表情:happy] 与 [情绪:开心] 在两种呈现下效果一致）
      if (sceneMode === 'portrait') {
        const hit = resolveEmotionKey(expName);
        if (hit) applyPortraitEmotion(hit.key);
      } else {
        void setExpression(expName);
      }
    }
    const motionName = lastTagValue(t, '动作');
    if (motionName) void playMotion(motionName);

    // 显式情绪优先。
    // ⚠️ 这里以前是 `driveEmotion(...); return;`，会把下面所有标签一起跳过——
    // 而系统提示词要求 AI 每条回复都带一个情绪标签，结果 [位置]/[大小]/[背景]
    // 几乎永远不会被执行，且因为标签不显示给用户，从表面完全看不出来。
    // 现在只把「跳过自动推断」这一件事交给这个标志，不再提前返回。
    const emoName = lastTagValue(t, '情绪');
    const explicitEmotion = emoName ? (driveEmotion(emoName) !== false) : false;

    const pos = lastTagValue(t, '位置');
    if (pos) setModelPositionByTag(pos);
    const size = lastTagValue(t, '大小');
    if (size) setModelSizeByTag(size);
    const bg = lastTagValue(t, '背景');
    if (bg) {
      // 先问场景背景资源包（真图优先），认不出才回落到预设色 —— 见 resolveBackgroundValue
      const value = resolveBackgroundValue(bg);
      if (value && window.Live2DCall?.setBackground) window.Live2DCall.setBackground(value);
    }

    // 没有显式表情、也没有识别成功的显式情绪时，才按触发词自动推断
    if (!expName && !explicitEmotion) {
      const inferred = inferEmotionFromText(t);
      if (inferred) driveEmotion(inferred);
    }
  }

  function playRandomMotion() {
    const keys = Object.keys(MOTION_MAP);
    const next = keys[Math.floor(Math.random() * keys.length)];
    void playMotion(next);
  }

  let aiVoiceMuted = false;
  function toggleMute() {
    aiVoiceMuted = !aiVoiceMuted;
    if (aiVoiceMuted) {
      // 静音 AI 声音：停止嘴动
      stopMouth();
    }
  }

  // ===== 舞台内的对话框（打字机 + 发送） =====
  // 为什么要有它：合并后"情景演绎"不再只是一块全屏画面 —— 用户在这里
  // 既能看到立绘 / 模型，也要能直接说话。气泡与剧情界面同一份数据（host.getMessages），
  // 所以两边谁说的话对方都看得见。
  let bubbleTyping = null;   // { timer, full }
  let bubbleLastKey = '';
  let bubblePoll = null;
  /** 已经念过的那条消息 id（避免轮询把它重复念一遍） */
  let lastSpokenMessageId = '';
  /**
   * 朗读：**默认开、不可关**。
   *
   * 判决理由：朗读要不要开是"有没有配 TTS"决定的（没配就念不出来，见 speakBubble
   *   里的 configured 判断），不需要再叠一个开关 —— 一个"开了也不一定响"的开关
   *   只会让人怀疑是不是坏了。已配 TTS 的用户进来就听到声音，这才是他要的效果。
   */
  const speechEnabled = true;   // 只读：不再有开关（见上面的说明）
  let speakStartedAt = 0;
  /** 打字机开关（设置页可关；关掉就是整段直接出现） */
  let typewriterOn = (function () {
    try { return LS.getItem(L2D_PREFIX + 'typewriter') !== '0'; } catch { return true; }
  })();

  function bubbleEls() {
    const wrap = document.getElementById('live2d-bubble-wrap');
    return {
      text: wrap ? wrap.querySelector('#live2d-gg-text') : null,
      name: wrap ? wrap.querySelector('#live2d-gg-name') : null,
    };
  }

  /** 打字机：长文本只做"逐字出现"的观感，速度固定，不按字数拖时间 */
  function typeBubble(text) {
    const { text: el } = bubbleEls();
    if (!el) return;
    if (bubbleTyping) { clearInterval(bubbleTyping.timer); bubbleTyping = null; }
    const full = String(text || '');
    if (!typewriterOn) { el.textContent = full; el.classList.remove('typing'); return; }
    // 长了就分块出字（每 16ms 一批），否则一段几百字要等十几秒
    const step = Math.max(1, Math.ceil(full.length / 140));
    let shown = 0;
    el.textContent = '';
    el.classList.add('typing');
    bubbleTyping = {
      full,
      get shown() { return shown; },
      timer: setInterval(() => {
        shown = Math.min(full.length, shown + step);
        el.textContent = full.slice(0, shown);
        if (shown >= full.length) {
          clearInterval(bubbleTyping.timer);
          bubbleTyping = null;
          el.classList.remove('typing');
        }
      }, 16),
    };
  }

  /** 气泡显示最新一条可见消息（与剧情界面同一筛选规则） */
  function syncBubble(force) {
    const msgs = (host.getMessages() || []).filter((m) => m && m.text && m.role !== 'system' && m.hidden !== true);
    const last = msgs[msgs.length - 1];
    const key = last ? (last.id + ':' + String(last.text).length) : '';
    if (!force && key === bubbleLastKey) return;
    bubbleLastKey = key;
    const { name } = bubbleEls();
    if (!last) return;
    if (name) name.textContent = last.role === 'user' ? '你' : '伊蕾娜';
    typeBubble(last.text);
    // AI 的新回复 → 朗读（和主界面同一条 TTS 链路）。
    //   只在**这条消息是新出现的 AI 消息**时念：用户自己的话不念，
    //   第一次打开舞台也不把历史最后一条重念一遍（force 时跳过）。
    if (last.role !== 'user' && !force && last.id !== lastSpokenMessageId) {
      speakBubble(last);
    }
  }

  /**
   * 朗读当前这条 AI 回复。
   *
   * 走 host.speak（core.js 的 ElainaHost.speech）而不是自己发 TTS 请求：
   *   供应商、鉴权、日语朗读稿都在宿主设置里，插件不该复制一份。
   * 没有配置 TTS 时静默跳过 —— 这是"没装语音就只显示文字"的正常形态，不是错误。
   */
  function speakBubble(msg) {
    // 朗读没有开关：配了 TTS 就念（下面的 configured 判断），没配就只显示文字。
    if (typeof host.speak !== 'function') return;
    let configured = false;
    try { configured = typeof host.speechConfigured === 'function' && host.speechConfigured(); } catch (e) { configured = false; }
    if (!configured) return;
    const id = String((msg && msg.id) || '');
    if (!id) return;
    lastSpokenMessageId = id;
    try {
      host.speak(String(msg.text || ''), {
        messageId: id,
        onStart() { speakStartedAt = Date.now(); },
        onEnd() { speakStartedAt = 0; },
      }).catch(() => { /* 念不出来不该在界面上留噪音，文字已经在气泡里 */ });
    } catch (e) { /* 同上 */ }
  }


  function sendBubbleText() {
    const input = document.getElementById('live2d-gg-input');
    if (!input) return false;
    const t = String(input.value || '').trim();
    if (!t) return false;
    input.value = '';
    try {
      host.sendUserMessage(t);
      return true;
    } catch (e) {
      host.error('发送失败', e);
      input.value = t;
      return false;
    }
  }

  // ===== 立绘 / Live2D 双模式 =====
  // 用户在设置里选「用哪一套」：
  //   · live2d    —— 原通话画面（渲染引擎 + 模型）
  //   · portrait  —— 图片立绘（立绘包 elaina-avatar），没有模型也能看到角色
  //   两者共用同一个舞台、同一个气泡、同一个输入行，所以切换只是换"站在那儿的东西"。
  const SCENE_MODE_KEY = L2D_PREFIX + 'sceneMode';
  let sceneMode = 'live2d';
  try {
    const m = LS.getItem(SCENE_MODE_KEY);
    if (m === 'portrait' || m === 'live2d') sceneMode = m;
  } catch { /* ignore */ }

  function avatarApi() {
    return (window.ElainaAvatar && typeof window.ElainaAvatar.src === 'function') ? window.ElainaAvatar : null;
  }

  /** 立绘模式下按情绪换图；立绘包不在就显示说明，而不是留一块空白 */
  function applyPortraitEmotion(emoKey) {
    const img = document.getElementById('ggL2dPortraitImg');
    const empty = document.getElementById('ggL2dPortraitEmpty');
    if (!img) return;
    const api = avatarApi();
    const list = api ? api.EMOTIONS : [];
    const key = list.indexOf(emoKey) >= 0 ? emoKey : 'calm';
    const src = api ? api.src(key) : '';
    if (!src) {
      img.style.display = 'none';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    img.style.display = '';
    if (img.getAttribute('src') === src) return;
    img.setAttribute('src', src);
    img.classList.remove('emo-swap');
    void img.offsetWidth;
    img.classList.add('emo-swap');
  }

  /** 把当前立绘 / 模型那套界面切到指定模式（不动存储：设置页改完再调 setSceneMode） */
  function applySceneMode() {
    const hostEl = document.getElementById('live2d-call-host');
    const portrait = document.getElementById('ggL2dPortrait');
    const adjust = document.getElementById('live2d-adjust-toggle');
    const tag = document.getElementById('live2d-name-tag');
    const isPortrait = sceneMode === 'portrait';
    if (hostEl) hostEl.classList.toggle('portrait', isPortrait);
    // ⚠️ 不要隐藏 #live2d-canvas-wrap —— 立绘层就住在它里面，
    //   隐藏容器会把立绘一起藏掉（选择立绘后舞台一片空的直接原因）。
    //   只藏 canvas 本身即可，规则在 CSS：#live2d-call-host.portrait #live2d-canvas。
    if (portrait) portrait.classList.toggle('on', isPortrait);
    // 「调整」只对 Live2D 有意义（立绘走自适应构图）
    if (adjust) adjust.style.display = isPortrait ? 'none' : '';
    if (tag) tag.textContent = isPortrait ? '图片立绘' : (selectedModel || '情景演绎中');
    if (isPortrait) {
      // 立绘模式下没有 canvas 盖着，背景由 stage 的 CSS 背景承担
      applyBackground();
      applyPortraitEmotion(currentEmotionName());
      try { app?.ticker?.stop?.(); } catch { /* ignore */ }
    } else if (isOpen && app) {
      // 切回模型：如果之前一次都没加载成功（只是被隐藏），这里补一次
      if (!model) void loadModel();
      applyBackground();
      startRenderLoop();
    }
  }

  /** 最近一条 AI 回复里的情绪标签（立绘模式下用来选图） */
  function currentEmotionName() {
    return lastTagValue(String((host.getMessages() || []).slice(-1)[0]?.text || ''), '情绪') || 'calm';
  }

  /**
   * 切换模式（设置页调用；打开中会立刻生效）。
   * @param {'live2d'|'portrait'} mode
   */
  function setSceneMode(mode) {
    const next = mode === 'portrait' ? 'portrait' : 'live2d';
    sceneMode = next;
    try { LS.setItem(SCENE_MODE_KEY, next); } catch { /* ignore */ }
    applySceneMode();
    // 提示词里写了"当前呈现：立绘/模型"，切换后要立刻重算，
    //   否则 AI 会按旧模式给动作/位置标签（立绘模式下那些不生效）。
    syncLive2DPromptHint();
    if (typeof GalgameBridge.refreshPromptHint === 'function') {
      try { GalgameBridge.refreshPromptHint(); } catch (e) { /* 宿主提示词刷新失败不影响界面 */ }
    }
    return next;
  }

  function getSceneMode() { return sceneMode; }

  // ===== 对外 API =====
  window.Live2DCall = {
    open, close,
    setBackground: function (v) {
      const safe = sanitizeBackground(v);
      bgStyle = safe;
      try { LS.setItem(L2D_PREFIX + "bg", safe); } catch { /* ignore */ }
      applyBackground();
    },
    getBackground: function () { return bgStyle; },

    // ---- 当前模型----
    // 「Live2D 引擎与模型」的卡片界面要用它：显示"正在使用"标记、以及点一下切换。
    // 为什么由本插件提供而不是让资源包自己存：**当前用哪个模型是"消费方"的状态**，
    //   不是资源本身的状态（同一个模型可以既给视频通话用、又给将来的桌宠用，
    //   两边选的可以不同）。放资源包那边会导致两个消费方互相覆盖。
    /** 当前选中的模型名（空串 = 还没选/都不可用） */
    getSelectedModel() { return selectedModel; },
    /**
     * 切换当前模型。
     * 通话进行中会**立刻重载**（用户点一下就能看到换人），没开则只记住选择。
     */
    setSelectedModel(name) {
      const n = String(name || '');
      if (!n || n === selectedModel) return false;
      selectedModel = n;
      // 舞台里没有模型下拉，选择只来自设置页；开着的话直接重载
      if (isOpen) void loadModel();
      return true;
    },

    deleteModel,
    // 供设置页在"重命名模型"之后刷新通话界面的下拉，并迁移按模型名存设置
    applyRenamedModel,
    toggleMute,
    setExpression,
    playMotion,
    driveEmotion,
    toggleAdjustBox,
    // 鼠标跟随开关（设置 → Live2D）
    setMouseFollow,
    isMouseFollow() { return mouseFollowEnabled; },
    // 鼠标跟随幅度（0-100，10 = 原始幅度 = 1.0 倍）
    setMouseFollowScale,
    getMouseFollowScale() { return mouseFollowScale; },
    getMouseFollowScaleMax() { return MOUSE_SCALE_MAX; },
    // 幅度信息：告诉设置面板"该模型的头部在 ×N 就到量程上限了"。
    // 头部幅度被模型自身参数范围锁死，超过这个倍率只有身体跟随还会继续变大。
    getFollowAmpInfo() {
      const cm = model?.internalModel?.coreModel;
      if (!cm) return { loaded: false };
      const sat = headSaturateK(cm);
      return {
        loaded: true,
        headSaturateAt: Number.isFinite(sat) ? Math.round(sat * 10) / 10 : null,
        bodyParamCount: resolveParamIds('bodyX').length + resolveParamIds('bodyY').length,
      };
    },
    // 静音时不应再动嘴（主应用也会跳过 TTS 播放，这里是双保险）
    speakStart() { if (aiVoiceMuted) return; startMouth(); },
    speakEnd() { stopMouth(); },
    // 供主应用查询静音状态：静音 = 不播放 AI 语音（[操作:静音]）
    isVoiceMuted() { return aiVoiceMuted; },
    // 当前模型可用表情/动作（只给文件名，不带目录与扩展名）。
    // 2026-10：实现抽到 l2dExpressionNames()，因为**提示词注入**也要用同一份逻辑
    //   （两处各写一份迟早走样）。本方法保留为对外查询接口。
    getAvailableExpressions() { return l2dModelCapNames(); },
    // 当前模型是否带水印开关（供提示词提示 AI 用 [操作:隐藏水印]）
    hasWatermark() { return Boolean(watermarkExp); },

    // ---- 标签协议：只保留"表现"部分 ----
    // 这里的变化（解耦）：
    //   旧实现在本文件里持有 stripTags() 与 drive() → handleAgentOperation()，
    //   而 handleAgentOperation 是**全部 [操作:] 标签的唯一分发器** ——
    //   文件操作、电脑命令、手机操作、整理记忆全在里面。
    //   宿主各处又都写成 `if (window.Live2DCall) { ... }`，
    //   于是"Live2D 不在"就等于"整个 Agent 系统失效 + 标签漏出来给用户看"。
    //   现在：剥离与操作分发归宿主（web/js/agent-tags.js），
    //   本文件只提供**表现**（表情/动作/情绪/位置/大小/背景），
    //   并通过 registerOperationHandler 把 Live2D 独有的两个操作
    //   （水印 / 静音）追加进宿主的分发链。
    //   下面这两个旧名保留为薄壳，只为不打断可能的外部调用；
    //   新代码请用 ElainaTags.strip / ElainaTags.drive。
    stripTags(text) {
      return window.ElainaTags ? window.ElainaTags.strip(text) : String(text || '');
    },
    drive(text) {
      if (window.ElainaTags) window.ElainaTags.drive(text);
    },
    drivePresentation: drivePresentation,
    /**
     * 当前这段"表现指南"提示词（静态指南 + 模型可用表情/动作 + 水印说明）。
     * 合并后由 galgame 的 syncSceneHint 取走，与场景说明拼成**一段**再注入 ——
     * 同一插件调两次 setPromptHint 是覆盖而不是拼接，两段分开注会丢一段。
     */
    promptHintText() {
      return typeof sessionL2dHintProvider === 'function' ? sessionL2dHintProvider() : '';
    },

    isOpen() { return isOpen; },
    // ---- 立绘 / Live2D 双模式（设置页用）----
    /** 当前模式：'live2d' | 'portrait' */
    getSceneMode,
    /** 切换模式（打开中立刻生效；写 galgame.live2d.sceneMode） */
    setSceneMode,
    // ---- 给 AI / 外部调用的"自由调节"接口（两种呈现都支持）----
    /** 可用的背景名字：{ presets: ['深蓝'…], scenes: ['雪夜'…] } */
    listBackgrounds() { return listBackgroundNames(); },
    /** 按名字换背景（预设色或场景图；认不出则原样当 CSS，经 sanitize） */
    setBackgroundByName(name) {
      const value = resolveBackgroundValue(name);
      if (!value) return false;
      // 先过白名单：认不出的名字（既不是预设也不是场景图）不该被当成 CSS 写进去
      const safe = sanitizeBackground(value);
      if (!safe) return false;
      window.Live2DCall.setBackground(safe);
      return true;
    },
    /** 可用的情绪键（立绘与模型共用这套词表） */
    listEmotions() { return Object.keys(EMOTION_MAP); },
    /** 按情绪/表情词切换表现（立绘换图、模型换表情；无法识别返回 false） */
    setEmotion(name) { return driveEmotion(name); },
    // ---- 朗读（与主界面同一条 TTS 链路；默认开，没有开关）----
    /** 语音是否已配置（供应商 + Key 齐全）。没配时朗读静默跳过 */
    speechConfigured() {
      try { return typeof host.speechConfigured === 'function' && host.speechConfigured(); } catch (e) { return false; }
    },
    /** 手动念最新一条 AI 回复（设置页"试听"用） */
    speakLatest() {
      const msgs = (host.getMessages() || []).filter((m) => m && m.text && m.role !== 'user' && m.hidden !== true);
      const last = msgs[msgs.length - 1];
      if (!last) return false;
      speakBubble(last);
      return true;
    },
    // ---- 语音输入（说话 → 识别 → 发送）----
    /** ASR 是否已配置（false 时舞台不显示麦克风按钮） */
    dictationConfigured() {
      try { return typeof host.dictationConfigured === 'function' && host.dictationConfigured(); } catch (e) { return false; }
    },
    /** 开麦 / 结束并发送；action 缺省为切换 */
    dictate(action) {
      try { return typeof host.dictate === 'function' ? host.dictate(action) : false; } catch (e) { return false; }
    },
    /** 当前语音输入状态：idle / listening / paused / thinking / error */
    dictationState() {
      try { return typeof host.dictationState === 'function' ? String(host.dictationState()) : 'idle'; } catch (e) { return 'idle'; }
    },
    /** 发一句话（气泡输入行也行；供设置页"测试"或有其它入口用） */
    sendMessage(text) {
      const t = String(text == null ? '' : text).trim();
      if (!t) return false;
      try { host.sendUserMessage(t); return true; } catch (e) { return false; }
    },
    // ---- 设置页要用的读写接口（都带存储，立即生效）----
    /** 可用模型名清单（没打开舞台时也能列出：走模型接口的本地清单） */
    getModelList() {
      // 模型清单住在「Live2D 引擎与模型」里（api.list() 是异步的，走
      // /api/live2d/models）。这里顺手补一次，拿不到就用已知的列表 ——
      // 打开舞台后 loadModel 会把它刷新成权威值。
      if (models && models.ok && models.api && typeof models.api.list === 'function') {
        Promise.resolve(models.api.list()).then((arr) => {
          if (Array.isArray(arr) && arr.length) {
            modelsList = arr.map((m) => (typeof m === 'string' ? { name: m } : m));
          }
        }).catch(() => { /* 离线/服务没起：保持现状 */ });
      }
      return modelsList.map((m) => (typeof m === 'string' ? m : (m && m.name) || '')).filter(Boolean);
    },
    getMouseFollow() { return !!mouseFollowEnabled; },
    setMouseFollow(on) { setMouseFollow(on); },
    getMouseFollowScale() { return mouseFollowScale; },
    setMouseFollowScale(level) { setMouseFollowScale(level); },
    /** 把当前模型的大小与位置恢复成"按屏幕高度自适应"的初始值 */
    resetModelView() {
      try { LS.removeItem(resizeStorageKey()); } catch { /* ignore */ }
      needsInitScale = true;
      if (isOpen && model) void loadModel();
      return true;
    },
    /** 对话框打字机开关（关闭则整段直接出现） */
    setTypewriter(on) {
      typewriterOn = !!on;
      try { LS.setItem(L2D_PREFIX + 'typewriter', typewriterOn ? '1' : '0'); } catch { /* ignore */ }
    },
    // 真实语音音量 → 嘴型（VAD 简化）：0~1 音量；传 null/0 恢复正弦波并停嘴
    setVoiceEnergy(level) {
      if (level == null || Number(level) < 0.015) {
        voiceEnergy = null;
        if (speaking) stopMouth();
        return;
      }
      voiceEnergy = Math.min(1.5, Number(level));
      if (!speaking) startMouth();
    },
  };

  // 语音音量走宿主事件（见 app-05-voice.js 的说明）。
  // 搬迁后改走 host.on：订阅登记在 mod 系统里，**停用插件时会被自动摘掉**
  //   （见 mods.js 的"注册即副作用"）。宿主侧 hasListeners('voice-energy')
  //   随之变假，于是连音量分析器都不会再建 —— 省掉未启用时的逐帧开销。
  host.on('voice-energy', (level) => {
    try { window.Live2DCall.setVoiceEnergy(level); } catch (e) { /* 忽略 */ }
  });

  // 不打开通话也把"当前用哪个模型"确定下来 —— 否则模型管理界面上的
  // 「正在使用」标记一直是空的（见 initSelectedModel 的说明）。
  // 不 await：它是纯补状态，失败也不该拖慢插件加载。
  void initSelectedModel();

  // 先注入一次提示词（不等模型加载）。
  //   为什么这里也要有一次：`loadModel()` 只在**打开通话**时才跑，而聊天从第一句
  //   就开始了 —— 如果只在那里同步，用户在没开过视频通话之前发的消息都收不到
  //   表现标签指南（表现为"AI 不会用 [情绪:]"）。这里先用当前已知的信息注入一份：
  //   模型清单可能还没拿到（那 ② 段就为空，AI 退回 [情绪:…] 通用匹配），
  //   等真正加载模型后 loadModel() 会用完整清单再同步一次覆盖掉它。
  syncLive2DPromptHint();

  host.log('已就绪（引擎与模型来自 live2d-models）');
}

// 暴露给 register.js（经典脚本共享全局作用域，不 export）
GalgameBridge.initLive2DCore = initLive2DCore;