/* dsh-auto-compaction client bundle.
 * Hand-written in the ModuleLoader wrapper shape DSH's client runtime uses.
 *
 * Renders the 设置 → 会话压缩 section. All persistence goes through the
 * package's own RPC channel ("/dsh-auto-compaction"), whose node half writes
 * ~/.dsh-handoff-compaction/settings.json — the same file the engine reads on
 * every decision, so a save takes effect without restarting DSH.
 */
window.__ModuleLoader__.load({
  id: "dsh-auto-compaction",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var ReactDOM = require("react-dom");
    var h = React.createElement;

    var name = "dsh-auto-compaction";
    var inject = ["slots", "connection"];
    var CHANNEL = "/dsh-auto-compaction";

    /* 全部取自宿主在 body 上投射的 --dsw-alias-* 令牌，深浅色由宿主切换
     * body[data-ds-dark-theme]，插件不判断主题；兜底值只在宿主未提供时生效。
     * 强调色是插件自己的标识色，只有它需要在 CSS 里按主题给两个值。 */
    var C = {
      text: "var(--dsw-alias-label-primary, #e8e9ea)",
      muted: "var(--dsw-alias-label-secondary, #9aa0a6)",
      faint: "var(--dsw-alias-label-tertiary, #7f858c)",
      line: "var(--dsw-alias-border-l2, #2c2e33)",
      panel: "var(--dsw-alias-bg-layer-2, #191a1d)",
      field: "var(--dsw-alias-bg-layer-1, #151619)",
      canvas: "var(--dsw-alias-bg-base, #151619)",
      accent: "var(--dac-accent, #4c8dff)",
      accentSoft: "var(--dac-accent-soft, rgba(76,141,255,.14))",
      accentLine: "var(--dac-accent-line, rgba(76,141,255,.55))",
      ok: "var(--dsw-alias-state-success-primary, #3fb950)",
      error: "var(--dsw-alias-state-error-primary, #e5534b)",
      card: "var(--dsw-alias-bg-layer-3, #2c2e33)",
      track: "rgba(127,133,140,.55)",
    };

    var DEFAULT_TEMPLATE = "~/.dsh-handoff-compaction/template.md";
    /* Preset names come from DSH's own registry through the `scope` RPC, never
     * from a list baked in here: a release that renames or adds a preset must
     * not leave this page showing names that no longer exist. */
    var presetLabels = {};
    function rememberPresetLabels(list) {
      for (var i = 0; i < list.length; i += 1) {
        var entry = list[i];
        if (entry && typeof entry.id === "string") {
          presetLabels[entry.id] = typeof entry.label === "string" && entry.label.length > 0 ? entry.label : entry.id;
        }
      }
    }
    function presetLabel(id) {
      return presetLabels[String(id)] || String(id || "未命名预设");
    }
    var DISPLAY_OPTIONS = [
      { id: "orbit", label: "轨道环" },
      { id: "strip", label: "状态条" },
      { id: "ring", label: "进度环" },
      { id: "topbar", label: "顶部条" },
      { id: "corner", label: "右上角" },
    ];
    var EXAMPLE_WINDOW = 250000, EXAMPLE_RESERVED = 20000, EXAMPLE_HEADROOM = 10000;
    // The engine clamps this to half of the live model window; the settings
    // page can only show the example, never a hard-coded per-model ceiling.
    var MID_TASK_MIN_TRIGGER = 20000;
    var MID_TASK_EXAMPLE_MAX = EXAMPLE_WINDOW / 2;

    var DISPLAY_STYLES = ["orbit", "strip", "ring", "topbar", "corner"];
    var displayStyle = "orbit";
    var displayStyleListeners = [];

    function normalizeDisplayStyle(value) {
      return DISPLAY_STYLES.indexOf(value) >= 0 ? value : "orbit";
    }
    function publishDisplayStyle(value) {
      var next = normalizeDisplayStyle(value);
      if (next === displayStyle) return;
      displayStyle = next;
      for (var i = 0; i < displayStyleListeners.length; i += 1) {
        try { displayStyleListeners[i](displayStyle); } catch (error) { /* a bad subscriber must not break the dock */ }
      }
    }
    function subscribeDisplayStyle(listener) {
      displayStyleListeners.push(listener);
      return function unsubscribe() {
        var index = displayStyleListeners.indexOf(listener);
        if (index >= 0) displayStyleListeners.splice(index, 1);
      };
    }
    function loadDisplayStyle(connection) {
      if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") return;
      call(connection, "get").then(function (value) {
        if (value && typeof value === "object") publishDisplayStyle(value.displayStyle);
      }).catch(function () { /* keep the default orbit */ });
    }

    /* Timeline display prefs mirror lib/timeline-prefs.js; the bundle cannot
     * import local modules, so the normalization is inlined (same split as
     * displayStyle). UI-only: the engine records history regardless. */
    var timelinePrefs = { enabled: true, position: "chat" };
    var timelineListeners = [];
    function normalizeTimelinePosition(value) {
      return value === "tab" ? "tab" : "chat";
    }
    function publishTimelinePrefs(settings) {
      var next = {
        enabled: !settings || settings.timelineEnabled !== false,
        position: normalizeTimelinePosition(settings && settings.timelinePosition),
      };
      if (next.enabled === timelinePrefs.enabled && next.position === timelinePrefs.position) return;
      timelinePrefs = next;
      for (var i = 0; i < timelineListeners.length; i += 1) {
        try { timelineListeners[i](timelinePrefs); } catch (error) { /* a bad subscriber must not break the dock */ }
      }
    }
    function subscribeTimelinePrefs(listener) {
      timelineListeners.push(listener);
      return function unsubscribe() {
        var index = timelineListeners.indexOf(listener);
        if (index >= 0) timelineListeners.splice(index, 1);
      };
    }
    function loadTimelinePrefs(connection) {
      if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") return;
      call(connection, "get").then(function (value) {
        if (value && typeof value === "object") publishTimelinePrefs(value);
      }).catch(function () { /* keep the current prefs */ });
    }

    function clampPercent(raw) {
      var n = Number(raw);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(100, Math.round(n)));
    }
    function snapPercent(raw) {
      return Math.max(0, Math.min(100, Math.round(Number(raw) / 5) * 5));
    }
    function fmt(n) { return Math.round(n).toLocaleString("en-US"); }

    function call(connection, endpoint, payload, timeoutMs) {
      var signal;
      try {
        if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
          signal = AbortSignal.timeout(typeof timeoutMs === "number" ? timeoutMs : 8000);
        }
      } catch (e) { signal = undefined; }
      return Promise.resolve(connection.rpc.call(CHANNEL, endpoint, payload || {}, signal)).then(function (res) {
        if (res && res.ok === false) throw new Error((res.error && res.error.message) || "RPC failed");
        return res && typeof res === "object" && "value" in res ? res.value : res;
      });
    }

    /* ---------- compaction status dock ---------- */

    var STATUS_STYLE_ID = "dsh-auto-compaction-status-style";
    var STATUS_TEXT = "var(--dsh-text-primary, var(--dsw-alias-label-primary, #e8e9ea))";
    var STATUS_MUTED = "var(--dsh-text-secondary, var(--dsw-alias-label-secondary, #9aa0a6))";
    var STATUS_FAINT = "var(--dsh-text-tertiary, var(--dsw-alias-label-tertiary, #7f858c))";
    var STATUS_BORDER = "var(--dsh-border, var(--dsw-alias-border-l2, #2c2e33))";
    // Opaque elevated surface. The menu token is intentionally translucent
    // (menu layers add their own backdrop blur); the status surfaces must stay
    // readable over live conversation text without a blur.
    var STATUS_SURFACE = "var(--dsw-alias-bg-layer-3, #353638)";
    var STATUS_PANEL = STATUS_SURFACE;
    var STATUS_ACCENT = "var(--dsw-alias-state-business-primary, #4c8dff)";
    var STATUS_SUCCESS = "var(--dsw-alias-state-success-primary, #3fb950)";
    var STATUS_WARN = "var(--dsw-alias-state-warn-primary, #d29922)";
    var STATUS_ERROR = "var(--dsw-alias-state-error-primary, #e5534b)";

    function ensureStatusStyles() {
      try {
        if (typeof document === "undefined" || document.getElementById(STATUS_STYLE_ID) !== null) return;
        var style = document.createElement("style");
        style.id = STATUS_STYLE_ID;
        style.textContent = [
          "@keyframes dshHandoffPulse{0%,100%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1)}}",
          "@keyframes dshHandoffShimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}",
          "@keyframes dshHandoffSpin{to{transform:rotate(360deg)}}",
          ".dsh-handoff-pulse{animation:dshHandoffPulse 1.25s ease-in-out infinite}",
          ".dsh-handoff-fill::after{content:\"\";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);animation:dshHandoffShimmer 1.5s linear infinite}",
          ".dsh-handoff-orbit{position:relative;width:56px;height:56px;border-radius:50%;border:2px solid var(--dsh-border,#303338)}",
          ".dsh-handoff-orbit::before{content:\"\";position:absolute;inset:-2px;border-radius:50%;border:2px solid transparent;border-top-color:var(--dsw-alias-state-business-primary,#4c8dff);border-right-color:rgba(76,141,255,.45);animation:dshHandoffSpin 1.15s linear infinite}",
          ".dsh-handoff-orbit::after{content:\"\";position:absolute;inset:13px;border-radius:50%;border:2px solid transparent;border-bottom-color:var(--dsw-alias-state-business-primary,#4c8dff);animation:dshHandoffSpin 1.8s linear infinite reverse}",
          ".dsh-handoff-orbit-core{position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4c8dff);box-shadow:0 0 12px rgba(76,141,255,.7);animation:dshHandoffPulse 1.25s ease-in-out infinite}",
          ".dsh-handoff-mini-orbit{position:relative;width:26px;height:26px;border-radius:50%;border:1.5px solid var(--dsh-border,#303338)}",
          ".dsh-handoff-mini-orbit::before{content:\"\";position:absolute;inset:-1.5px;border-radius:50%;border:1.5px solid transparent;border-top-color:var(--dsw-alias-state-business-primary,#4c8dff);animation:dshHandoffSpin 1.15s linear infinite}",
          ".dsh-handoff-mini-orbit::after{content:\"\";position:absolute;inset:7px;border-radius:50%;border:1.5px solid transparent;border-bottom-color:var(--dsw-alias-state-business-primary,#4c8dff);animation:dshHandoffSpin 1.8s linear infinite reverse}",
          ".dsh-handoff-opt{width:12px;height:12px;display:inline-block;position:relative;flex:0 0 auto}",
          ".dsh-handoff-opt-strip::before{content:\"\";position:absolute;left:0;right:0;top:4px;height:4px;border-radius:2px;border:1px solid currentColor}",
          ".dsh-handoff-opt-strip::after{content:\"\";position:absolute;left:2px;right:2px;top:6px;height:1px;background:currentColor;opacity:.7}",
          ".dsh-handoff-opt-ring{border:1.5px solid currentColor;border-radius:50%}",
          ".dsh-handoff-opt-ring::after{content:\"\";position:absolute;inset:3px;border-radius:50%;border:1px solid currentColor;opacity:.5}",
          ".dsh-handoff-opt-orbit{border:1px solid currentColor;border-radius:50%}",
          ".dsh-handoff-opt-orbit::after{content:\"\";position:absolute;inset:-1px;border-radius:50%;border:1px solid transparent;border-top-color:currentColor}",
          ".dsh-handoff-opt-top::before{content:\"\";position:absolute;left:0;right:0;top:1px;height:2px;background:currentColor;border-radius:1px}",
          ".dsh-handoff-opt-top::after{content:\"\";position:absolute;left:2px;right:2px;bottom:1px;height:5px;border:1px solid currentColor;border-radius:2px;opacity:.6}",
          "@media (prefers-reduced-motion:reduce){.dsh-handoff-pulse,.dsh-handoff-orbit::before,.dsh-handoff-orbit::after,.dsh-handoff-orbit-core,.dsh-handoff-mini-orbit::before,.dsh-handoff-mini-orbit::after{animation:none}.dsh-handoff-fill::after{animation:none}}",
          ".dac-section{--dac-accent:#2f6fed;--dac-accent-soft:rgba(47,111,237,.10);--dac-accent-line:rgba(47,111,237,.45)}",
          "body[data-ds-dark-theme] .dac-section{--dac-accent:#4c8dff;--dac-accent-soft:rgba(76,141,255,.14);--dac-accent-line:rgba(76,141,255,.55)}",
        ].join("");
        document.head.appendChild(style);
      } catch (error) { /* styling must never break the dock */ }
    }

    function clockText(startedAt) {
      var start = Number(startedAt);
      var seconds = Number.isFinite(start) && start > 0 ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
      return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
    }

    function statusProgress(status) {
      if (status && status.step === "commit") return 92;
      if (status && status.retrying) return 70;
      if (status && status.step === "summary") return 55;
      return 12;
    }

    function statusStep(status) {
      if (status && status.retrying) return "补全 2/3";
      if (status && status.step === "prepare") return "1/3 读取缓存";
      if (status && status.step === "commit") return "3/3 替换历史";
      return "2/3 写文档";
    }

    function fetchStatus(connection, sessionId) {
      return call(connection, "status", { sessionId: sessionId }, 3500);
    }

    /**
     * Anchor the corner card to the conversation area instead of the window:
     * its top lines up with the first message row (below the 对话/轨迹 tabs) and
     * its right edge keeps the header's inset, so it never covers the tab row.
     * The width shrinks to the gutter between the message column and the window
     * edge when the window is narrow.
     */
    function cornerPlacement(desiredWidth) {
      var right = (typeof window === "undefined" ? 0 : window.innerWidth) - 20;
      var top = 96;
      var width = desiredWidth;
      try {
        var body = document.querySelector("[data-conversation-content]");
        var br = body && body.getBoundingClientRect();
        if (br && br.height > 80) {
          top = Math.round(br.top) + 8;
          right = Math.round(br.right) - 20;
        }
        var card = document.querySelector("[data-composer-card]");
        var cr = card && card.getBoundingClientRect();
        if (cr && cr.width > 120) {
          var clearance = parseFloat(getComputedStyle(card).getPropertyValue("--dsh-composer-side-clearance")) || 16;
          var columnRight = Math.round(cr.right) - clearance;
          width = Math.max(184, Math.min(desiredWidth, right - columnRight - 10));
        }
      } catch (error) { /* keep the window-corner fallback */ }
      width = Math.max(160, Math.min(width, right - 12));
      return { left: Math.max(8, Math.round(right - width)), top: Math.round(top), width: Math.round(width) };
    }

    function StatusDock(props) {
      ensureStatusStyles();
      var connection = props.connection;
      var sessionId = props.sessionId;
      var cancel = props.cancel;

      var loaded = React.useState(null);
      var status = loaded[0], setStatus = loaded[1];
      var dismissed = React.useState(0);
      var dismissedAt = dismissed[0], setDismissedAt = dismissed[1];
      var clock = React.useState(0);
      var tick = clock[0], setTick = clock[1];
      void tick;
      var styleState = React.useState(displayStyle);
      var themeStyle = styleState[0], setThemeStyle = styleState[1];

      React.useEffect(function () {
        return subscribeDisplayStyle(setThemeStyle);
      }, []);

      React.useEffect(function () {
        loadDisplayStyle(connection);
      }, [connection]);

      React.useEffect(function () {
        if (!connection || !sessionId) return undefined;
        var alive = true;
        var timer;
        function poll() {
          fetchStatus(connection, sessionId).then(function (value) {
            if (!alive) return;
            var next = value && typeof value === "object" ? value : null;
            setStatus(function (previous) {
              if (previous === null || next === null) return next;
              if (previous.updatedAt === next.updatedAt && previous.phase === next.phase) return previous;
              return next;
            });
            timer = setTimeout(poll, next !== null && next.phase === "running" ? 1000 : 4000);
          }).catch(function () {
            if (!alive) return;
            timer = setTimeout(poll, 5000);
          });
        }
        poll();
        return function () { alive = false; if (timer !== undefined) clearTimeout(timer); };
      }, [connection, sessionId]);

      React.useEffect(function () {
        if (!status) return undefined;
        var timer = setInterval(function () { setTick(function (value) { return value + 1; }); }, 1000);
        return function () { clearInterval(timer); };
      }, [status === null ? "" : status.phase]);

      if (!status || !status.phase) return null;

      var now = Date.now();
      var startedAt = Number(status.startedAt || 0);
      var timeoutMs = Number(status.timeoutMs) > 0 ? Number(status.timeoutMs) : 600000;
      var staleRunning = status.phase === "running" && startedAt > 0 && now - startedAt > timeoutMs + 60000;
      var view = staleRunning ? "failed" : status.phase;
      if (view !== "running" && view !== "done" && view !== "failed") return null;
      if (dismissedAt !== 0 && Number(status.updatedAt || 0) === dismissedAt) return null;

      if (view === "done") {
        var doneAt = Number(status.completedAt || status.updatedAt || 0);
        if (doneAt > 0 && now - doneAt > 8000) return null;
      }
      if (view === "failed" && !staleRunning) {
        var failedAt = Number(status.failedAt || status.updatedAt || 0);
        if (failedAt > 0 && now - failedAt > 120000) return null;
      }

      var color = view === "running" ? STATUS_ACCENT : view === "done" ? STATUS_SUCCESS : STATUS_ERROR;
      if (staleRunning) color = STATUS_WARN;

      var title;
      var sub;
      var progress = statusProgress(status);
      if (view === "running") {
        title = status.retrying
          ? (status.writing ? "正在从头重写交接文档" : "正在补全交接文档")
          : "正在压缩历史会话";
        var pieces = [];
        if (Number(status.totalTokens) > 0) {
          pieces.push("上下文 " + fmt(Number(status.totalTokens)) + (Number(status.thresholdTokens) > 0 ? " / " + fmt(Number(status.thresholdTokens)) : ""));
        }
        pieces.push(status.retrying ? "第 " + String(status.summaryAttempt || 2) + " 次请求" : "期间发送的消息会排队");
        if (Array.isArray(status.missingSections) && status.missingSections.length > 0) {
          pieces.push("缺：" + status.missingSections.join("、"));
        }
        sub = pieces.join(" · ");
      } else if (view === "done") {
        var nodes = Number(status.shadowedNodes) || 0;
        var tokens = Number(status.shadowedTokens) || 0;
        title = nodes > 0
          ? "已压缩 " + fmt(nodes) + " 条历史记录（约 " + fmt(tokens) + " tokens）"
          : (status.note === "no compactable range" ? "没有需要压缩的历史" : "压缩完成");
        sub = "旧消息仍可用回滚功能恢复";
      } else {
        title = staleRunning ? "压缩可能已中断（超时）· 历史未改动" : "交接文档生成失败 · 历史未改动";
        if (staleRunning) {
          sub = "下一次空闲会重新尝试";
        } else if (String(status.errorCode || "") === "INCOMPLETE_SUMMARY") {
          sub = "摘要不完整，已放弃提交 · 下次空闲重试";
        } else if (String(status.error || "").toLowerCase().indexOf("cancel") >= 0) {
          sub = "压缩已取消 · 下次空闲重试";
        } else {
          sub = status.error ? String(status.error).slice(0, 140) : "下次空闲重试";
        }
      }

      function handleCancel() {
        if (typeof cancel !== "function") return;
        try {
          var pending = cancel();
          if (pending && typeof pending.catch === "function") pending.catch(function () { /* status updates via polling */ });
        } catch (error) { /* the stop button remains available */ }
      }

      function handleDismiss() {
        setDismissedAt(Number(status.updatedAt || 0));
      }

      var ghost = {
        border: "1px solid " + STATUS_BORDER,
        background: "transparent",
        color: STATUS_MUTED,
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 11,
        lineHeight: "16px",
        fontFamily: "inherit",
        cursor: "pointer",
        flex: "0 0 auto",
      };
      var close = {
        border: 0,
        background: "transparent",
        color: STATUS_FAINT,
        fontSize: 14,
        lineHeight: "20px",
        width: 22,
        height: 22,
        padding: 0,
        cursor: "pointer",
        flex: "0 0 auto",
      };

      if (view === "running" && themeStyle !== "strip") {
        var stepNumber = status.step === "prepare" ? 1 : status.step === "commit" ? 3 : 2;
        var ringPct = stepNumber === 1 ? 33 : stepNumber === 3 ? 92 : 66;
        var cardSub = status.retrying
          ? (status.writing ? "正在重写摘要 · " : "正在补全摘要 · ") + clockText(startedAt)
          : clockText(startedAt) + " · 期间消息会排队";
        if (themeStyle === "topbar") {
          var topLine = h("div", { style: {
            position: "fixed",
            left: 0,
            top: 84,
            width: "100vw",
            height: 2,
            zIndex: 70,
            pointerEvents: "none",
            background: "rgba(127,133,140,.28)",
          } },
            h("div", { className: "dsh-handoff-fill", style: { height: "100%", width: "62%", background: STATUS_ACCENT, position: "relative", overflow: "hidden" } })
          );
          var pill = h("div", { style: {
            position: "fixed",
            left: "50%",
            top: 92,
            transform: "translateX(-50%)",
            zIndex: 70,
            pointerEvents: "none",
          } },
            h("span", { style: {
              display: "inline-flex", alignItems: "center", gap: 7, height: 26, padding: "0 11px",
              borderRadius: 999, border: "1px solid " + STATUS_ACCENT,
              background: STATUS_SURFACE, color: STATUS_TEXT, fontSize: 11, whiteSpace: "nowrap",
            } },
              h("span", { className: "dsh-handoff-pulse", style: { width: 7, height: 7, borderRadius: "50%", background: STATUS_ACCENT } }),
              "压缩中 · " + statusStep(status) + " · " + clockText(startedAt)
            )
          );
          return ReactDOM.createPortal(h(React.Fragment, null, topLine, pill), document.body);
        }
        if (themeStyle === "corner") {
          var place = cornerPlacement(268);
          return ReactDOM.createPortal(
            h("div", {
              role: "status",
              "aria-live": "polite",
              "data-dsh-handoff-status": "running",
              title: "压缩期间发送的消息会排队",
              style: {
                position: "fixed",
                left: place.left,
                top: place.top,
                zIndex: 70,
                pointerEvents: "none",
                boxSizing: "border-box",
                width: place.width,
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "9px 11px",
                borderRadius: 10,
                background: STATUS_SURFACE,
                border: "1px solid " + STATUS_BORDER,
                borderLeft: "2px solid " + STATUS_ACCENT,
                boxShadow: "0 14px 34px rgba(0,0,0,.38)",
              },
            },
              h("span", { className: "dsh-handoff-pulse", style: { width: 8, height: 8, borderRadius: "50%", background: STATUS_ACCENT, flex: "0 0 auto", marginTop: 5 } }),
              h("div", { style: { minWidth: 0, flex: 1 } },
                h("div", { style: { fontSize: 12, fontWeight: 600, color: STATUS_TEXT, lineHeight: "17px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, title),
                h("div", { style: { marginTop: 2, fontSize: 10.5, color: STATUS_MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                  clockText(startedAt) + " · " + statusStep(status) + (place.width >= 216 ? " · 消息会排队" : ""))
              )
            ),
            document.body
          );
        }
        var indicator = themeStyle === "ring"
          ? h("div", { style: { position: "relative", width: 64, height: 64 } },
            h("div", { style: {
              position: "absolute", inset: 0, borderRadius: "50%",
              background: "conic-gradient(" + STATUS_ACCENT + " 0 " + ringPct + "%, rgba(127,133,140,.28) " + ringPct + "% 100%)",
              WebkitMask: "radial-gradient(circle, transparent 55%, #000 58%)",
              mask: "radial-gradient(circle, transparent 55%, #000 58%)",
            } }),
            h("div", { style: {
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              fontFamily: "ui-monospace,Consolas,monospace", fontSize: 13, fontWeight: 500,
              color: STATUS_TEXT, fontVariantNumeric: "tabular-nums",
            } },
              stepNumber + "/3",
              h("span", { style: { fontSize: 9, color: STATUS_MUTED, fontFamily: "inherit", fontWeight: 400 } }, "写文档")
            )
          )
          : h("div", { className: "dsh-handoff-orbit" }, h("div", { className: "dsh-handoff-orbit-core" }));
        var overlayStyle = {
          position: "fixed",
          left: 0,
          top: 0,
          width: "100vw",
          height: "100vh",
          zIndex: 70,
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxSizing: "border-box",
          paddingLeft: "min(200px, 15vw)",
          // The overlay never blocks input, so no blur or dim: a modal-looking
          // scrim here would falsely suggest the conversation is frozen.
        };
        var cardStyle = {
          width: 264,
          maxWidth: "82%",
          background: STATUS_SURFACE,
          border: "1px solid " + STATUS_BORDER,
          borderRadius: 14,
          padding: "16px 16px 14px",
          boxShadow: "0 20px 46px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 7,
          textAlign: "center",
          pointerEvents: "none",
        };
        return ReactDOM.createPortal(
          h("div", { role: "status", "aria-live": "polite", "data-dsh-handoff-status": "running", style: overlayStyle },
            h("div", { style: cardStyle },
              indicator,
              h("div", { style: { fontSize: 12.5, fontWeight: 600, color: STATUS_TEXT } }, title),
              h("div", { style: { fontSize: 11, color: STATUS_MUTED } }, cardSub),
              h("div", { style: { fontSize: 10.5, color: STATUS_MUTED, opacity: 0.85 } }, "完成后把最旧的这段历史收成一条交接文档")
            )
          ),
          document.body
        );
      }

      return h("div", {
        role: "status",
        "aria-live": "polite",
        "data-dsh-handoff-status": view,
        style: {
          boxSizing: "border-box",
          width: "100%",
          maxWidth: "var(--dsh-composer-card-max-width, 860px)",
          margin: "0 auto 6px",
          padding: "7px 10px 8px",
          border: "1px solid " + STATUS_BORDER,
          borderLeft: "3px solid " + color,
          borderRadius: 8,
          background: STATUS_PANEL,
          boxShadow: "0 8px 22px rgba(0,0,0,.28)",
          color: STATUS_TEXT,
          fontSize: 12,
          lineHeight: "18px",
          display: "flex",
          flexDirection: "column",
          gap: 5,
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
          h("span", {
            className: view === "running" ? "dsh-handoff-pulse" : "",
            "aria-hidden": true,
            style: { width: 8, height: 8, borderRadius: "50%", background: color, flex: "0 0 auto" },
          }),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
              h("span", { style: { fontSize: 12, fontWeight: 500, color: STATUS_TEXT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 } }, title),
              view === "running"
                ? h("span", { style: { fontSize: 11, color: color, border: "1px solid " + color, borderRadius: 999, padding: "0 6px", lineHeight: "16px", flex: "0 0 auto", opacity: 0.9 } }, statusStep(status))
                : null
            ),
            sub
              ? h("div", { style: { fontSize: 11, color: STATUS_MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, sub)
              : null
          ),
          view === "running"
            ? h("span", { "aria-live": "off", style: { fontSize: 11, color: STATUS_MUTED, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" } }, clockText(startedAt))
            : null,
          view === "running" && typeof cancel === "function"
            ? h("button", { type: "button", onClick: handleCancel, style: ghost, title: "取消压缩（历史保持原样，排队的消息会保留）" }, "取消")
            : null,
          view !== "running"
            ? h("button", { type: "button", onClick: handleDismiss, style: close, "aria-label": "关闭状态提示", title: "关闭" }, "×")
            : null
        ),
        view === "running"
          ? h("div", { style: { height: 3, borderRadius: 99, background: "rgba(127,133,140,.28)", overflow: "hidden" } },
            h("div", {
              className: "dsh-handoff-fill",
              style: {
                height: "100%",
                width: progress + "%",
                borderRadius: 99,
                background: color,
                position: "relative",
                overflow: "hidden",
                transition: "width .25s ease",
              },
            })
          )
          : null
      );
    }

    /**
     * Failure dialog centered in the conversation area.
     *
     * The engine writes `failureHint` into the status sidecar with the live
     * numbers (used / window / remaining / needed / suggestion). Two cases:
     * the switch is off and the idle compaction ran too late, or it is on but
     * the trigger was still too small. Both offer the one-click repair, and the
     * checkbox maps to the 压缩失败提示 switch in the settings page.
     */
    function FailureHint(props) {
      ensureStatusStyles();
      var connection = props.connection;
      var sessionId = props.sessionId;
      var hintState = React.useState(null);
      var hint = hintState[0], setHint = hintState[1];
      var prefsState = React.useState(null);
      var prefs = prefsState[0], setPrefs = prefsState[1];
      var closedState = React.useState(0);
      var closedAt = closedState[0], setClosedAt = closedState[1];
      var noAskState = React.useState(false);
      var noAsk = noAskState[0], setNoAsk = noAskState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];

      React.useEffect(function () {
        if (!connection || !sessionId) return undefined;
        var alive = true;
        var timer;
        function poll() {
          fetchStatus(connection, sessionId).then(function (value) {
            if (!alive) return;
            setHint(value && value.failureHint ? value.failureHint : null);
          }).catch(function () { /* keep the previous hint */ });
          timer = setTimeout(poll, 4000);
        }
        poll();
        return function () { alive = false; if (timer !== undefined) clearTimeout(timer); };
      }, [connection, sessionId]);

      React.useEffect(function () {
        if (!connection) { setPrefs({}); return undefined; }
        var alive = true;
        call(connection, "get").then(function (value) {
          if (alive) setPrefs(value && typeof value === "object" ? value : {});
        }).catch(function () { if (alive) setPrefs({}); });
        return function () { alive = false; };
      }, [connection, hint === null ? 0 : Number(hint.at || 0)]);

      if (hint === null || hint === undefined || prefs === null) return null;
      if (prefs.suppressFailureHint === true) return null;
      if (Number(hint.at || 0) <= Number(prefs.hintClearedAt || 0)) return null;
      if (closedAt !== 0 && closedAt === hint.at) return null;

      var used = Math.max(0, Number(hint.usedTokens) || 0);
      var windowTokens = Math.max(1, Number(hint.windowTokens) || 1);
      var remaining = Math.max(0, Number(hint.remainingTokens) || 0);
      var needed = Math.max(0, Number(hint.neededTokens) || 0);
      var trigger = Number(hint.triggerTokens) > 0 ? Number(hint.triggerTokens) : MID_TASK_MIN_TRIGGER;
      var suggest = Number(hint.suggestTokens) > 0 ? Number(hint.suggestTokens) : trigger;
      var raising = hint.kind === "raise-trigger";
      var usedPct = Math.min(100, used / windowTokens * 100);

      // Centered on the whole DSH window, not the conversation column: the
      // scrim covers the sidebar too, so the dialog reads as an app-level
      // notice rather than a message inside the chat.
      function finish(value) {
        setPrefs(value && typeof value === "object" ? value : prefs);
        setClosedAt(hint.at);
        setBusy(false);
      }
      function repair() {
        if (busy) return;
        setBusy(true);
        call(connection, "fix", raising
          ? { action: "raise", tokens: suggest }
          : { action: "enable", tokens: MID_TASK_MIN_TRIGGER }, 6000)
          .then(finish)
          .catch(function () { setBusy(false); });
      }
      function close() {
        setClosedAt(hint.at);
        call(connection, "ackHint", { suppress: noAsk === true }, 5000)
          .then(function (value) { if (value && typeof value === "object") setPrefs(value); })
          .catch(function () { /* closed locally regardless */ });
      }

      var card = {
        width: "min(492px, 100%)",
        boxSizing: "border-box",
        background: STATUS_SURFACE,
        border: "1px solid " + STATUS_BORDER,
        borderRadius: 16,
        boxShadow: "0 18px 52px rgba(0,0,0,.45)",
        color: STATUS_TEXT,
        padding: "18px 20px 16px",
        maxHeight: "calc(100% - 24px)",
        overflowY: "auto",
      };
      var titleStyle = { margin: 0, fontSize: 14.5, fontWeight: 600, lineHeight: "20px" };
      var subStyleDialog = { marginTop: 2, fontSize: 12, color: STATUS_MUTED };
      var para = { margin: "0 0 9px", fontSize: 12.5, lineHeight: 1.75, color: STATUS_MUTED };
      var strong = { color: STATUS_TEXT, fontWeight: 600, fontVariantNumeric: "tabular-nums" };
      var cause = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 11px", fontSize: 12, background: "rgba(127,133,140,.10)" };
      var causeValue = { color: STATUS_TEXT, fontWeight: 600, fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace,Consolas,monospace", fontSize: 11.5 };

      return ReactDOM.createPortal(
        h("div", {
          role: "dialog",
          "aria-modal": "true",
          "aria-label": raising ? "中途压缩失败" : "交接文档生成失败",
          "data-dsh-handoff-hint": hint.kind || "enable-midtask",
          style: {
            position: "fixed", inset: 0,
            zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24, boxSizing: "border-box", background: "rgba(8,10,14,.42)",
          },
        },
          h("div", { style: card },
            h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12 } },
              h("span", {
                "aria-hidden": true,
                style: {
                  flex: "0 0 auto", width: 30, height: 30, borderRadius: 9, display: "flex",
                  alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700,
                  background: raising ? "rgba(210,153,34,.16)" : "rgba(229,83,75,.14)",
                  color: raising ? STATUS_WARN : STATUS_ERROR,
                  boxShadow: "inset 0 0 0 1px " + (raising ? "rgba(210,153,34,.38)" : "rgba(229,83,75,.32)"),
                },
              }, "!"),
              h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
                h("h3", { style: titleStyle }, raising ? "中途压缩也失败了" : "交接文档生成失败"),
                h("div", { style: subStyleDialog }, raising ? "触发余量偏小，压缩请求放不下" : "上下文余量不足，历史未改动")
              ),
              h("button", {
                type: "button", onClick: close, "aria-label": "关闭",
                style: { border: 0, background: "transparent", color: STATUS_FAINT, fontSize: 17, lineHeight: "20px", width: 22, height: 22, padding: 0, cursor: "pointer" },
              }, "×")
            ),

            h("div", { style: { marginTop: 13 } },
              raising
                ? h("p", { style: para },
                  "「任务中途压缩」已经开启，但触发余量只有 ", h("span", { style: strong }, fmt(trigger)),
                  "，而这次压缩请求实际需要约 ", h("span", { style: strong }, fmt(needed)),
                  "（含思考、摘要输出与工具定义），仍然没放下。")
                : h("p", { style: para },
                  "这一轮结束时上下文已用到 ", h("span", { style: strong }, fmt(used) + " / " + fmt(windowTokens)),
                  " tokens，只剩 ", h("span", { style: strong }, fmt(remaining)),
                  "。写交接文档本身还要思考并生成摘要（约需 ", h("span", { style: strong }, fmt(needed)),
                  "），请求放不下，所以这次压缩没有执行，历史保持原样。"),

              h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: 11, color: STATUS_MUTED, margin: "10px 0 6px" } },
                h("span", null, "已用 " + fmt(used) + " / " + fmt(windowTokens)),
                h("span", { style: { color: raising ? STATUS_WARN : STATUS_ERROR, fontWeight: 600 } }, "余量 " + fmt(remaining))
              ),
              h("div", { style: { position: "relative", display: "flex", height: 22, border: "1px solid " + STATUS_BORDER, borderRadius: 6, overflow: "hidden", background: "rgba(127,133,140,.12)" } },
                h("div", { style: { width: usedPct.toFixed(2) + "%", background: "linear-gradient(90deg, rgba(76,141,255,.18), rgba(76,141,255,.40))" } }),
                h("div", { style: { flex: "1 1 auto", background: raising ? "repeating-linear-gradient(135deg, rgba(229,83,75,.20) 0 5px, transparent 5px 10px)" : "transparent", borderLeft: "1px solid " + (raising ? STATUS_ERROR : STATUS_BORDER) } })
              ),

              h("div", { style: { marginTop: 12, border: "1px solid " + STATUS_BORDER, borderRadius: 10, overflow: "hidden" } },
                h("div", { style: cause },
                  h("span", null, "已用上下文"),
                  h("span", { style: causeValue }, fmt(used) + " / " + fmt(windowTokens))
                ),
                h("div", { style: Object.assign({}, cause, { borderTop: "1px solid " + STATUS_BORDER }) },
                  h("span", null, raising ? "当前触发余量" : "压缩请求可用余量"),
                  h("span", { style: Object.assign({}, causeValue, { color: STATUS_ERROR }) }, fmt(raising ? trigger : remaining))
                ),
                h("div", { style: Object.assign({}, cause, { borderTop: "1px solid " + STATUS_BORDER }) },
                  h("span", null, "思考 + 摘要 + 输出预留"),
                  h("span", { style: causeValue }, "≈ " + fmt(needed))
                )
              ),

              h("p", { style: Object.assign({}, para, { marginTop: 11 }) },
                raising
                  ? h("span", null, "把触发余量提高到 ", h("span", { style: strong }, fmt(suggest)), "，下次会在余量还够的时候先压缩，再继续当前任务。")
                  : h("span", null, "开启「任务中途压缩」后，会在每一步开始前检查余量，余量不足就先压缩再继续，不会拖到最后一轮回答结束。")
              )
            ),

            h("label", {
              style: {
                display: "flex", alignItems: "flex-start", gap: 9, marginTop: 12, padding: "9px 11px",
                border: "1px solid " + STATUS_BORDER, borderRadius: 9, background: "rgba(127,133,140,.08)", cursor: "pointer",
              },
            },
              h("input", {
                type: "checkbox", checked: noAsk,
                onChange: function () { setNoAsk(!noAsk); },
                style: { width: 14, height: 14, margin: "2px 0 0", flex: "0 0 auto", accentColor: STATUS_ACCENT },
              }),
              h("span", { style: { fontSize: 11.5, color: STATUS_MUTED, lineHeight: 1.55 } },
                "不再提示这类失败",
                h("span", { style: { display: "block", fontSize: 10.5, color: STATUS_FAINT, marginTop: 1 } }, "可在「设置 → 会话压缩 → 压缩失败提示」重新开启")
              )
            ),

            h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" } },
              h("button", {
                type: "button", onClick: repair, disabled: busy,
                style: {
                  border: "1px solid transparent", background: STATUS_ACCENT, color: "#fff",
                  fontSize: 12, fontWeight: 600, padding: "7px 12px", borderRadius: 8,
                  cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1, whiteSpace: "nowrap",
                },
              }, raising ? "把触发余量提高到 " + fmt(suggest) : "启用任务中途压缩"),
              h("span", { style: { flex: "1 1 auto" } }),
              h("button", {
                type: "button", onClick: close, disabled: busy,
                style: { border: "1px solid transparent", background: "transparent", color: STATUS_FAINT, fontSize: 12, padding: "7px 10px", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap" },
              }, raising ? "暂不调整" : "稍后")
            ),

            h("div", { style: { marginTop: 10, fontSize: 10.5, color: STATUS_FAINT, lineHeight: 1.65 } },
              raising
                ? "建议值按当前模型窗口 " + fmt(windowTokens) + " 计算，上限为窗口一半；调整后下一次判断即生效。"
                : "默认触发余量 " + fmt(MID_TASK_MIN_TRIGGER) + " tokens，可在设置里调整；立即生效，无需重启，也不会改写你的配置文件。"
            )
          )
        ),
        document.body
      );
    }

    function ThemePreview(props) {
      var style = normalizeDisplayStyle(props.theme);
      var chatChildren = [
        h("div", { key: "user", style: { marginLeft: "auto", maxWidth: "62%", border: "1px solid " + C.accentLine, background: C.accentSoft, borderRadius: "7px 7px 2px 7px", padding: "4px 6px", fontSize: 9, color: C.text } }, "请完整读取这个文件并总结…"),
        h("div", { key: "lines", style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 6 } },
          h("i", { key: "l1", style: { height: 4, borderRadius: 99, background: C.line } }),
          h("i", { key: "l2", style: { height: 4, borderRadius: 99, background: C.line, width: "88%" } }),
          h("i", { key: "l3", style: { height: 4, borderRadius: 99, background: C.line, width: "62%" } })
        )
      ];
      var overlay = null;
      if (style === "ring") {
        overlay = h("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
          h("div", { style: { width: 104, border: "1px solid " + C.line, borderRadius: 8, background: C.card, padding: "7px 6px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, textAlign: "center" } },
            h("div", { style: { position: "relative", width: 28, height: 28 } },
              h("div", { style: { width: 28, height: 28, borderRadius: "50%", background: "conic-gradient(" + C.accent + " 0 66%, " + C.line + " 66% 100%)", WebkitMask: "radial-gradient(circle, transparent 52%, #000 55%)", mask: "radial-gradient(circle, transparent 52%, #000 55%)" } }),
              h("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 7.5, fontFamily: "ui-monospace,Consolas,monospace" } }, "2/3")
            ),
            h("div", { style: { fontSize: 8.5, fontWeight: 500 } }, "正在压缩历史会话"),
            h("div", { style: { fontSize: 7.5, color: C.muted } }, "00:42 · 消息会排队")
          )
        );
      } else if (style === "orbit") {
        overlay = h("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
          h("div", { style: { width: 104, border: "1px solid " + C.line, borderRadius: 8, background: C.card, padding: "7px 6px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, textAlign: "center" } },
            h("div", { className: "dsh-handoff-mini-orbit" },
              h("span", { style: { position: "absolute", left: "50%", top: "50%", width: 4, height: 4, margin: "-2px 0 0 -2px", borderRadius: "50%", background: C.accent } })
            ),
            h("div", { style: { fontSize: 8.5, fontWeight: 500 } }, "正在压缩历史会话…"),
            h("div", { style: { fontSize: 7.5, color: C.muted } }, "00:42 · 消息会排队")
          )
        );
      } else if (style === "topbar") {
        overlay = h(React.Fragment, null,
          h("div", { key: "line", style: { position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, " + C.accent + " 0 62%, " + C.line + " 62% 100%)" } }),
          h("div", { key: "pillrow", style: { display: "flex", justifyContent: "center", paddingTop: 5 } },
            h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, height: 16, padding: "0 6px", borderRadius: 999, border: "1px solid " + C.accentLine, background: C.card, fontSize: 8 } },
              h("span", { className: "dsh-handoff-pulse", style: { width: 4, height: 4, borderRadius: "50%", background: C.accent } }),
              "压缩中 · 2/3 · 00:42"
            )
          )
        );
      } else if (style === "corner") {
        overlay = h("div", { style: { position: "absolute", right: 8, top: 9, boxSizing: "border-box", width: 104, display: "flex", alignItems: "flex-start", gap: 4, padding: "4px 5px", borderRadius: 5, background: C.card, border: "1px solid " + C.line, borderLeft: "2px solid " + C.accent } },
          h("span", { className: "dsh-handoff-pulse", style: { width: 4, height: 4, borderRadius: "50%", background: C.accent, marginTop: 4, flex: "0 0 auto" } }),
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontSize: 7, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "正在压缩历史会话"),
            h("div", { style: { fontSize: 6.5, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "00:42 · 2/3 写文档")
          )
        );
      }
      var strip = style === "strip"
        ? h("div", { style: { margin: "0 8px 4px", border: "1px solid " + C.line, borderLeft: "2px solid " + C.accent, borderRadius: 5, background: C.card, padding: "4px 6px" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
            h("span", { className: "dsh-handoff-pulse", style: { width: 5, height: 5, borderRadius: "50%", background: C.accent } }),
            h("span", { style: { fontSize: 9, fontWeight: 500 } }, "正在压缩历史会话"),
            h("span", { style: { marginLeft: "auto", fontSize: 8, color: C.accent } }, "2/3")
          ),
          h("div", { style: { fontSize: 8, color: C.muted, marginTop: 1 } }, "10,735 / 30,000 · 消息会排队"),
          h("div", { style: { height: 2, borderRadius: 99, background: C.line, marginTop: 3, overflow: "hidden" } },
            h("div", { style: { width: "64%", height: "100%", background: C.accent, borderRadius: 99 } })
          )
        )
        : null;
      return h("div", { style: { marginTop: 9, border: "1px solid " + C.line, borderRadius: 8, background: C.canvas, overflow: "hidden" } },
        h("div", { style: { height: 128, display: "flex", flexDirection: "column" } },
          h("div", { style: { height: 24, flex: "0 0 24px", display: "flex", alignItems: "center", gap: 6, padding: "0 8px", borderBottom: "1px solid " + C.line, background: C.panel } },
            h("span", { style: { width: 5, height: 5, borderRadius: "50%", background: C.ok } }),
            h("span", { style: { fontSize: 9.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "读取大文件并提取校验串"),
            h("span", { style: { marginLeft: "auto", fontSize: 8.5, color: C.muted, border: "1px solid " + C.line, borderRadius: 999, padding: "0 6px" } }, "轻量本地")
          ),
          h("div", { style: { flex: 1, minHeight: 0, padding: (style === "topbar" ? 22 : 7) + "px 8px 7px", position: "relative", overflow: "hidden" } },
            (style === "topbar" || style === "corner") ? overlay : null,
            chatChildren,
            (style === "ring" || style === "orbit") ? overlay : null
          ),
          strip,
          h("div", { style: { flex: "0 0 26px", display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderTop: "1px solid " + C.line, background: C.panel } },
            h("div", { style: { flex: 1, height: 18, border: "1px solid " + C.line, borderRadius: 5, background: C.canvas, color: C.faint, fontSize: 8, display: "flex", alignItems: "center", padding: "0 6px", whiteSpace: "nowrap", overflow: "hidden" } }, "发消息或创建任务…"),
            h("span", { style: { width: 16, height: 16, borderRadius: "50%", background: C.accent, flex: "0 0 auto" } })
          )
        )
      );
    }

    function ToggleSwitch(props) {
      var on = props.checked === true;
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": on ? "true" : "false",
        "aria-label": props.label,
        onClick: function () { props.onChange(!on); },
        style: {
          position: "relative",
          width: 44,
          height: 24,
          flex: "0 0 auto",
          padding: 0,
          borderRadius: 999,
          border: "1px solid " + (on ? C.accentLine : C.line),
          background: on ? C.accent : C.track,
          cursor: "pointer",
          transition: "background .16s ease, border-color .16s ease",
        },
      },
        h("span", {
          "aria-hidden": "true",
          style: {
            position: "absolute",
            top: 2,
            left: on ? 22 : 2,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 3px rgba(0,0,0,.4)",
            transition: "left .16s ease",
          },
        })
      );
    }

    /* ---------- compaction timeline ---------- */

    var TIMELINE_STYLE_ID = "dsh-auto-compaction-timeline-style";
    var TL_PALETTE_DARK = { accent: "#f14b0b", bead: "#a84515", time: "#f2c8b8" };
    var TL_PALETTE_LIGHT = { accent: "#c33f08", bead: "#b0501f", time: "#7a2d0c" };

    /** Burnt orange on dark themes, a deeper ember when the app is light. */
    function accentColor() {
      try {
        var matches = (getComputedStyle(document.body).backgroundColor || "").match(/\d+/g);
        if (matches !== null && matches.length >= 3) {
          var lum = 0.299 * Number(matches[0]) + 0.587 * Number(matches[1]) + 0.114 * Number(matches[2]);
          if (lum > 150) return TL_PALETTE_LIGHT;
        }
      } catch (error) { /* keep the dark palette */ }
      return TL_PALETTE_DARK;
    }

    function ensureTimelineStyles() {
      try {
        if (typeof document === "undefined" || document.getElementById(TIMELINE_STYLE_ID) !== null) return;
        var style = document.createElement("style");
        style.id = TIMELINE_STYLE_ID;
        style.textContent = [
          ".dsh-tl{position:fixed;z-index:6;pointer-events:auto;",
          "transform:translateY(-50%);",
          "font-family:var(--dsh-font-sans,system-ui,'Segoe UI','Microsoft YaHei',sans-serif)}",
          ".dsh-tl-list{position:relative;width:100%}",
          ".dsh-tl-line{position:absolute;left:8px;width:1px;opacity:.45;",
          "background:linear-gradient(180deg,transparent,var(--dsh-tl-accent,#f14b0b) 12%,var(--dsh-tl-accent,#f14b0b) 88%,transparent)}",
          ".dsh-tl-ev{position:absolute;left:0;max-width:100%;display:flex;align-items:center;",
          "background:none;border:0;padding:0;margin:0;color:inherit;cursor:pointer;text-align:left;border-radius:4px}",
          ".dsh-tl-ev:hover{background:rgba(241,75,11,.07)}",
          ".dsh-tl-dot{flex:none;border-radius:50%;background:var(--dsh-tl-bead,#a84515);",
          "transition:background .12s,box-shadow .12s}",
          ".dsh-tl-ev:hover .dsh-tl-dot{background:var(--dsh-tl-accent,#f14b0b)}",
          ".dsh-tl-ev.on .dsh-tl-dot{background:var(--dsh-tl-accent,#f14b0b);",
          "box-shadow:0 0 0 3px rgba(241,75,11,.2),0 0 12px rgba(241,75,11,.5)}",
          ".dsh-tl-meta{margin-left:14px;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;",
          "color:var(--dsw-alias-label-secondary,#88939c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
          "font-variant-numeric:tabular-nums}",
          ".dsh-tl-meta b{font-weight:500;color:var(--dsh-tl-time,#f2c8b8)}",
          ".dsh-tl-ev:hover .dsh-tl-meta{color:var(--dsw-alias-label-primary,#c9d6e0)}",
          // Narrow gutter: keep the bead chain and the clock, drop the metrics.
          ".dsh-tl--compact .dsh-tl-metrics{display:none}",
          ".dsh-tl-backdrop{position:fixed;inset:0;z-index:200;background:rgba(6,9,11,.66);backdrop-filter:blur(5px);",
          "display:flex;align-items:center;justify-content:center;padding:24px}",
          ".dsh-tl-modal{width:min(1000px,92vw);height:min(660px,84vh);display:flex;flex-direction:column;overflow:hidden;",
          "background:var(--dsw-alias-bg-layer-3,#161d24);border:1px solid rgba(241,75,11,.25);border-radius:14px;",
          "box-shadow:0 40px 100px rgba(0,0,0,.6)}",
          ".dsh-tl-mh{display:flex;align-items:center;gap:12px;padding:14px 20px;",
          "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09))}",
          ".dsh-tl-mh h3{margin:0;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#eaf1f6)}",
          ".dsh-tl-mh small{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#88939c)}",
          ".dsh-tl-x{margin-left:auto;width:26px;height:26px;border-radius:6px;font-size:12px;line-height:1;",
          "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:none;cursor:pointer;",
          "color:var(--dsw-alias-label-secondary,#93a2ae)}",
          ".dsh-tl-x:hover{color:var(--dsw-alias-label-primary,#fff)}",
          ".dsh-tl-mb{flex:1;display:grid;grid-template-columns:352px minmax(0,1fr);min-height:0}",
          ".dsh-tl-stats{padding:18px 20px 16px;overflow:auto;",
          "border-right:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}",
          ".dsh-tl-hero{display:flex;align-items:center;gap:14px;margin-bottom:14px}",
          ".dsh-tl-ring{position:relative;width:84px;height:84px;flex:none}",
          ".dsh-tl-ring figcaption{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;",
          "justify-content:center;font-family:ui-monospace,Consolas,monospace;font-size:13px;",
          "color:var(--dsw-alias-label-primary,#eaf1f6)}",
          ".dsh-tl-ring figcaption small{font-size:8.5px;margin-top:2px;color:var(--dsw-alias-label-secondary,#88939c)}",
          ".dsh-tl-hero p{margin:0;font-size:11px;line-height:1.75;color:var(--dsw-alias-label-secondary,#88939c)}",
          ".dsh-tl-hero p b{display:block;margin-bottom:2px;white-space:nowrap;font-weight:500;",
          "font-family:ui-monospace,Consolas,monospace;font-size:15.5px;color:var(--dsw-alias-label-primary,#eaf1f6)}",
          ".dsh-tl-rows{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}",
          ".dsh-tl-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;font-size:11px;",
          "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));",
          "color:var(--dsw-alias-label-secondary,#88939c)}",
          ".dsh-tl-row b{font-weight:500;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;",
          "color:var(--dsw-alias-label-primary,#dbe6ee)}",
          ".dsh-tl-note{font-size:10px;line-height:1.7;margin:12px 0 0;color:var(--dsw-alias-label-tertiary,#6c7c88)}",
          ".dsh-tl-docwrap{display:flex;flex-direction:column;min-height:0;padding:14px 18px 18px}",
          ".dsh-tl-doctitle{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;",
          "font-size:10.5px;color:var(--dsw-alias-label-secondary,#88939c)}",
          ".dsh-tl-doctitle b{font-weight:500;color:var(--dsw-alias-label-primary,#c9d5de)}",
          ".dsh-tl-doc{margin:0;flex:1;overflow:auto;white-space:pre-wrap;font-size:11.5px;line-height:1.85;",
          "color:var(--dsw-alias-label-primary,#c8d5df);background:var(--dsw-alias-bg-layer-1,#10161b);",
          "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));border-radius:10px;padding:14px 16px}",
          "@media (max-width:900px){.dsh-tl-modal{width:96vw;height:88vh}",
          ".dsh-tl-mb{grid-template-columns:1fr}.dsh-tl-stats{border-right:0;",
          "border-bottom:1px solid rgba(255,255,255,.08)}}",
        ].join("");
        document.head.appendChild(style);
      } catch (error) { /* styling must never break the timeline */ }
    }

    function fetchHistory(connection, sessionId) {
      return call(connection, "history", { sessionId: sessionId, limit: 60 }, 3500);
    }

    function two(n) { return String(n).padStart(2, "0"); }
    function clockOf(ts) {
      var d = new Date(Number(ts) || 0);
      return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
    }
    function dateOf(ts) {
      var d = new Date(Number(ts) || 0);
      return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
    }
    function durationText(ms) {
      var n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return "—";
      if (n < 60000) return (n / 1000).toFixed(1) + " s";
      var total = Math.round(n / 1000);
      return Math.floor(total / 60) + " m " + two(total % 60) + " s";
    }
    /** Total words shown on the timeline: Chinese characters plus English words. */
    function wordCount(event) {
      var cjk = Number(event.cjk);
      var words = Number(event.words);
      if (Number.isFinite(cjk) || Number.isFinite(words)) {
        return (Number.isFinite(cjk) ? cjk : 0) + (Number.isFinite(words) ? words : 0);
      }
      return Number(event.summaryChars) || 0;
    }
    function wordText(event) {
      var cjk = Number(event.cjk);
      var words = Number(event.words);
      if (Number.isFinite(cjk) || Number.isFinite(words)) {
        return fmt(Number.isFinite(cjk) ? cjk : 0) + " 字" + (Number.isFinite(words) && words > 0 ? " · " + fmt(words) + " 词" : "");
      }
      return fmt(Number(event.summaryChars) || 0) + " 字符";
    }

    /**
     * DSH keeps the conversation body resident across the 对话/轨迹 tabs and
     * swaps only the active view; the timeline is portalled to <body>, so it
     * would otherwise float over the trajectory. The chat view's column is the
     * only one carrying data-chat-flow, so its absence means another tab.
     *
     * Returns the message column's rect (the widest flow, since collapsed
     * process groups carry the same attribute) or null while the column is
     * unmounted or still unsized mid-switch.
     */
    function chatColumn(content) {
      try {
        var nodes = content.querySelectorAll("[data-chat-flow]");
        var widest = null;
        var widestWidth = 0;
        for (var i = 0; i < nodes.length; i += 1) {
          var rect = nodes[i].getBoundingClientRect();
          if (rect.height > 0 && rect.width > widestWidth) {
            widest = rect;
            widestWidth = rect.width;
          }
        }
        return widestWidth >= 200 ? widest : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * Sit in the empty gutter left of the message column. Measured instead of
     * hard-coded so the timeline follows window resizes and the sidebar; when
     * the gutter is too narrow it hides rather than covering the conversation.
     */
    function timelinePlacement() {
      var out = { left: 12, top: 96, width: 248, height: 0, regionHeight: 0, visible: false, compact: false };
      try {
        var content = document.querySelector("[data-conversation-content]");
        var cr = content && content.getBoundingClientRect();
        if (!cr || cr.height <= 140) return out;
        // Anchor to the message column itself. Deriving it from the composer
        // card overestimates the left edge when the input is narrower than the
        // chat column, which pushed the chain into the text after a switch.
        var column = chatColumn(content);
        if (column === null) return out;
        var columnLeft = Math.round(column.left);
        // Content and scroll hooks can both report left = 0 (they wrap the
        // whole window), so the sidebar's right edge is the real gutter bound.
        var sidebar = document.querySelector("[data-dsh-sidebar-root]");
        var br = sidebar && sidebar.getBoundingClientRect();
        var scrollBody = content.querySelector("[data-conversation-scroll]");
        var sr2 = scrollBody && scrollBody.getBoundingClientRect();
        var contentLeft = Math.round(Math.max(
          br && br.width > 100 ? br.right : 0,
          cr.left,
          sr2 && sr2.height > 100 ? sr2.left : 0
        ));
        // Follow the native turn rail: it is centred in the scroll viewport minus the
        // composer and capped at 420px (see the rail's frame CSS). Centring on the
        // whole content area instead sits the chain lower than the rail, because
        // the composer occupies its bottom.
        var viewportTop = sr2 && sr2.height > 200 ? sr2.top : cr.top;
        var viewportHeight = sr2 && sr2.height > 200 ? sr2.height : cr.height;
        var seatEl = content.querySelector("[data-composer-seat]");
        var seatRect = seatEl && seatEl.getBoundingClientRect();
        var composerHeight = seatRect && seatRect.height >= 48 ? seatRect.height : 152;
        var band = viewportHeight - composerHeight;
        if (band < 200) return out;
        out.top = Math.round(viewportTop + band / 2);
        out.height = Math.round(band);
        // The chain lives in a fixed centred band; spacing adapts inside it so
        // a long history never pushes entries past the conversation edges.
        out.regionHeight = Math.round(Math.min(band - 64, 420));
        var width = Math.min(248, columnLeft - contentLeft - 24);
        var left = columnLeft - width - 12;
        if (left < contentLeft + 8) {
          left = contentLeft + 8;
          width = columnLeft - left - 12;
        }
        out.left = Math.round(left);
        out.width = Math.round(width);
        out.compact = out.width < 190;
        // Below ~130px even the stacked layout stops being readable: hide
        // rather than cover the sidebar or the messages.
        out.visible = out.height > 220 && out.width >= 130;
      } catch (error) { /* hidden when the layout cannot be measured */ }
      return out;
    }

    function TimelineDock(props) {
      ensureTimelineStyles();
      var connection = props.connection;
      var sessionId = props.sessionId;

      var eventsState = React.useState([]);
      var events = eventsState[0], setEvents = eventsState[1];
      var placeState = React.useState(function () { return timelinePlacement(); });
      var place = placeState[0], setPlace = placeState[1];
      var openState = React.useState(-1);
      var openIndex = openState[0], setOpenIndex = openState[1];
      var prefsState = React.useState(timelinePrefs);
      var prefs = prefsState[0], setPrefs = prefsState[1];

      React.useEffect(function () {
        return subscribeTimelinePrefs(setPrefs);
      }, []);

      React.useEffect(function () {
        loadTimelinePrefs(connection);
      }, [connection]);

      React.useEffect(function () {
        var pending = [];
        function clearPending() {
          for (var i = 0; i < pending.length; i += 1) clearTimeout(pending[i]);
          pending = [];
        }
        function update() {
          clearPending();
          observeSeat();
          setPlace(timelinePlacement());
        }
        // Tab and session switches re-mount the view; the column reports an
        // unsized/mid-transition width for a few frames, so re-measure shortly
        // after the switch instead of leaving the chain at a stale offset.
        function settle() {
          update();
          var delays = [80, 300, 900];
          for (var i = 0; i < delays.length; i += 1) {
            pending.push(setTimeout(function () { setPlace(timelinePlacement()); }, delays[i]));
          }
        }
        update();
        window.addEventListener("resize", update);
        var timer = setInterval(update, 2000);
        // Tab buttons only signal the swap through aria-selected (session tree
        // items too); watching that one attribute reacts on the next frame.
        var observer = null;
        try {
          observer = new MutationObserver(settle);
          observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
        } catch (error) { observer = null; }
        // The native rail tracks the composer height; so does ours now. A growing
        // input (multi-line draft) would otherwise leave the chain misaligned for
        // up to the 2s tick.
        var seatObserver = null;
        var observedSeat = null;
        function observeSeat() {
          if (!seatObserver) return;
          var content = document.querySelector("[data-conversation-content]");
          var seat = content === null ? null : content.querySelector("[data-composer-seat]");
          if (seat === observedSeat) return;
          if (observedSeat !== null) seatObserver.unobserve(observedSeat);
          observedSeat = seat;
          if (seat !== null) seatObserver.observe(seat);
        }
        try {
          seatObserver = new ResizeObserver(function () { update(); observeSeat(); });
          observeSeat();
        } catch (error) { seatObserver = null; }
        return function () {
          window.removeEventListener("resize", update);
          clearInterval(timer);
          clearPending();
          if (observer !== null) observer.disconnect();
          if (seatObserver !== null) seatObserver.disconnect();
        };
      }, []);

      React.useEffect(function () {
        if (!connection || !sessionId || !prefs.enabled || prefs.position !== "chat") return undefined;
        var alive = true;
        var timer;
        function poll() {
          fetchHistory(connection, sessionId).then(function (value) {
            if (!alive) return;
            var list = value && Array.isArray(value.events) ? value.events : [];
            setEvents(list);
            setOpenIndex(function (current) { return current >= list.length ? -1 : current; });
            timer = setTimeout(poll, 5000);
          }).catch(function () {
            if (!alive) return;
            timer = setTimeout(poll, 8000);
          });
        }
        poll();
        return function () { alive = false; if (timer !== undefined) clearTimeout(timer); };
      }, [connection, sessionId, prefs.enabled, prefs.position]);

      React.useEffect(function () {
        if (openIndex < 0) return undefined;
        function onKey(ev) { if (ev.key === "Escape") setOpenIndex(-1); }
        document.addEventListener("keydown", onKey);
        return function () { document.removeEventListener("keydown", onKey); };
      }, [openIndex]);

      if (!prefs.enabled || prefs.position !== "chat" || events.length === 0 || !place.visible) return null;

      var palette = accentColor();
      var accent = palette.accent;
      var active = openIndex >= 0 && openIndex < events.length ? events[openIndex] : null;
      // Same direction as the conversation: oldest at the top, newest at the
      // bottom, so a new compaction lands where the eye already is.
      var ordered = events;
      // Bead chain inside a fixed centred band: the pitch shrinks as events
      // accumulate; below the label floor only beads remain and their diameter
      // yields to the pitch so neighbours never touch.
      var regionH = Math.max(40, place.regionHeight);
      var n = ordered.length;
      var eh = 16;
      var pitch = n > 1 ? Math.min(34, (regionH - eh) / (n - 1)) : 0;
      if (n > 1 && pitch < 22) { eh = 14; pitch = Math.min(34, (regionH - eh) / (n - 1)); }
      var labels = n === 1 || pitch >= 18;
      if (!labels) { eh = 12; pitch = n > 1 ? Math.min(34, (regionH - eh) / (n - 1)) : 0; }
      var total = n > 1 ? (n - 1) * pitch + eh : eh;
      var off = Math.max(0, (regionH - total) / 2);

      var panel = h("div", {
        className: "dsh-tl" + (place.compact ? " dsh-tl--compact" : ""),
        "data-dsh-handoff-timeline": "1",
        style: {
          left: place.left + "px",
          top: place.top + "px",
          width: place.width + "px",
          "--dsh-tl-accent": palette.accent,
          "--dsh-tl-bead": palette.bead,
          "--dsh-tl-time": palette.time,
        },
      },
        h("div", { className: "dsh-tl-list", style: { height: regionH + "px" } },
          h("i", {
            className: "dsh-tl-line",
            "aria-hidden": true,
            style: { top: (off + eh / 2) + "px", height: Math.max(0, (n - 1) * pitch) + "px" },
          }),
          ordered.map(function (event, i) {
            var chars = wordCount(event);
            var bead = Math.max(4, Math.min(6 + Math.round(chars / 220), labels ? 12 : Math.max(4, Math.floor(pitch) - 2)));
            return h("button", {
              key: String(event.startedAt || i),
              type: "button",
              className: "dsh-tl-ev" + (i === n - 1 ? " on" : ""),
              title: clockOf(event.startedAt) + " · " + durationText(event.durationMs) + " · " + fmt(chars) + " 字 · 查看详情",
              onClick: function () { setOpenIndex(i); },
              style: { top: (off + i * pitch) + "px", height: eh + "px" },
            },
              h("span", { className: "dsh-tl-dot", style: { width: bead + "px", height: bead + "px", marginLeft: ((17 - bead) / 2) + "px" } }),
              labels ? h("span", { className: "dsh-tl-meta" },
                h("b", null, clockOf(event.startedAt)),
                h("span", { className: "dsh-tl-metrics" }, " · " + durationText(event.durationMs) + " · " + fmt(chars) + " 字")
              ) : null
            );
          })
        )
      );

      var modal = null;
      if (active !== null) {
        var before = Number(active.beforeTokens);
        var windowTokens = Number(active.contextWindow);
        var after = Number(active.afterTokens);
        var threshold = Number(active.thresholdTokens);
        var summaryTokens = Number(active.summaryTokens);
        var pctValue = before > 0 && windowTokens > 0 ? (before / windowTokens) * 100 : null;
        var ringSize = 84, ringR = ringSize / 2 - 7;
        var ringC = 2 * Math.PI * ringR, ringCenter = ringSize / 2;
        var filled = pctValue === null ? 0 : Math.max(0, Math.min(100, pctValue));
        var ring = h("figure", { className: "dsh-tl-ring" },
          h("svg", { viewBox: "0 0 " + ringSize + " " + ringSize, width: ringSize, height: ringSize, "aria-hidden": "true" },
            h("circle", { cx: ringCenter, cy: ringCenter, r: ringR, fill: "none", stroke: "rgba(241,75,11,.18)", strokeWidth: 7 }),
            h("circle", {
              cx: ringCenter, cy: ringCenter, r: ringR, fill: "none", stroke: accent, strokeWidth: 7, strokeLinecap: "round",
              strokeDasharray: (ringC * filled / 100).toFixed(1) + " " + ringC.toFixed(1),
              transform: "rotate(-90 " + ringCenter + " " + ringCenter + ")",
            })
          ),
          h("figcaption", null, pctValue === null ? "—" : pctValue.toFixed(1) + "%", h("small", null, "占窗口"))
        );

        var rows = [
          ["压缩用时", durationText(active.durationMs)],
          ["触发方式", active.trigger === "manual" ? "手动 /compact" : "自动（空闲时）"],
          ["交接文档", wordText(active)],
          ["摘要输出", Number.isFinite(summaryTokens) ? fmt(summaryTokens) + " tokens" : "—"],
          ["替换历史", (fmt(Number(active.shadowedNodes) || 0) + " 条 / " + fmt(Number(active.shadowedTokens) || 0) + " tokens")],
            ["模型", [active.provider, active.model].filter(Boolean).join(" · ") || "—"],
        ];

        modal = h("div", {
          className: "dsh-tl-backdrop",
          "data-dsh-handoff-timeline-modal": "1",
          onMouseDown: function (ev) { if (ev.target === ev.currentTarget) setOpenIndex(-1); },
        },
          h("div", { className: "dsh-tl-modal", role: "dialog", "aria-modal": "true", "aria-label": "压缩详情" },
            h("div", { className: "dsh-tl-mh" },
              h("h3", null, "第 " + String(openIndex + 1) + " 次压缩"),
              h("small", null, dateOf(active.startedAt) + " · " + clockOf(active.startedAt)),
              h("button", { type: "button", className: "dsh-tl-x", "aria-label": "关闭", onClick: function () { setOpenIndex(-1); } }, "×")
            ),
            h("div", { className: "dsh-tl-mb" },
              h("aside", { className: "dsh-tl-stats" },
                h("div", { className: "dsh-tl-hero" },
                  ring,
                  h("p", null,
                    h("b", null, (Number.isFinite(before) ? fmt(before) : "—") + " tokens"),
                    "触发时上下文",
                    h("br"),
                    "触发点阈值 " + (Number.isFinite(threshold) && threshold > 0 ? fmt(threshold) : "—"),
                    h("br"),
                    "压缩后 " + (Number.isFinite(after) ? fmt(after) : "—")
                  )
                ),
                h("div", { className: "dsh-tl-rows" },
                  rows.map(function (row) {
                    return h("div", { className: "dsh-tl-row", key: row[0] }, h("span", null, row[0]), h("b", null, row[1]));
                  })
                ),
                h("p", { className: "dsh-tl-note" }, "字数与时长为插件本地计算；tokens 取 DSH usage 与摘要调用 usage，不额外消耗模型算力。")
              ),
              h("div", { className: "dsh-tl-docwrap" },
                h("div", { className: "dsh-tl-doctitle" }, h("b", null, "交接文档全文"), h("span", null, wordText(active))),
                h("pre", { className: "dsh-tl-doc" }, String(active.summary || "（本次未记录交接文档）"))
              )
            )
          )
        );
      }

      return h(React.Fragment, null,
        ReactDOM.createPortal(panel, document.body),
        modal === null ? null : ReactDOM.createPortal(modal, document.body)
      );
    }

    var COMPACTION_TAB_STYLE_ID = "dsh-auto-compaction-tab-style";
    function ensureCompactionTabStyles() {
      try {
        if (typeof document === "undefined" || document.getElementById(COMPACTION_TAB_STYLE_ID) !== null) return;
        var style = document.createElement("style");
        style.id = COMPACTION_TAB_STYLE_ID;
        style.textContent = [
          ".dsh-ct{flex:1;min-height:0;height:100%;overflow:hidden;display:grid;grid-template-columns:282px minmax(0,1fr);",
          "font-family:var(--dsh-font-sans,system-ui,'Segoe UI','Microsoft YaHei',sans-serif)}",
          ".dsh-ct-rail{border-right:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));padding:16px 14px;overflow:auto;min-height:0}",
          ".dsh-ct-railhead{display:flex;align-items:baseline;justify-content:space-between;margin:0 4px 14px}",
          ".dsh-ct-railtitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#eaf1f6)}",
          ".dsh-ct-count{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#88939c)}",
          ".dsh-ct-tape{position:relative}",
          ".dsh-ct-tape::before{content:\"\";position:absolute;left:94px;top:12px;bottom:12px;width:1px;opacity:.45;",
          "background:linear-gradient(180deg,transparent,var(--dsh-ct-accent,#f14b0b) 12%,var(--dsh-ct-accent,#f14b0b) 88%,transparent)}",
          ".dsh-ct-ev{position:relative;display:grid;grid-template-columns:70px 26px minmax(0,1fr);gap:6px;align-items:center;",
          "width:100%;border:0;background:none;cursor:pointer;padding:7px 6px;border-radius:8px;text-align:left;margin-bottom:4px;color:inherit}",
          ".dsh-ct-ev:hover{background:rgba(255,255,255,.03)}",
          ".dsh-ct-ev.on{background:rgba(241,75,11,.12)}",
          ".dsh-ct-time{font-family:ui-monospace,Consolas,monospace;font-size:11px;text-align:right;font-variant-numeric:tabular-nums;",
          "color:var(--dsw-alias-label-primary,#d3d9df)}",
          ".dsh-ct-beadwrap{display:grid;place-items:center}",
          ".dsh-ct-bead{display:block;border-radius:50%;background:var(--dsh-ct-bead,#a84515)}",
          ".dsh-ct-ev.on .dsh-ct-bead{background:var(--dsh-ct-accent,#f14b0b);",
          "box-shadow:0 0 0 4px rgba(241,75,11,.16),0 0 12px rgba(241,75,11,.5)}",
          ".dsh-ct-meta{font-size:10px;line-height:1.5;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#88939c)}",
          ".dsh-ct-meta b{font-weight:500;color:var(--dsw-alias-label-primary,#c9d0d8)}",
          ".dsh-ct-detail{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:18px 22px 22px}",
          ".dsh-ct-detailhead{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}",
          ".dsh-ct-detailtitle{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#eaf1f6)}",
          ".dsh-ct-stamp{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#88939c)}",
          // Ring + metric rows sit side by side; the summary takes the rest.
          ".dsh-ct-top{display:grid;grid-template-columns:auto minmax(0,1fr);gap:20px;align-items:start}",
          ".dsh-ct-top .dsh-tl-hero{margin-bottom:0}",
          ".dsh-ct-top .dsh-tl-row{padding:5px 0}",
          ".dsh-ct-detail .dsh-tl-doctitle{margin-top:14px}",
          ".dsh-ct-detail .dsh-tl-doc{flex:1 1 0;min-height:0;overflow:auto}",
          ".dsh-ct-empty{flex:1;min-height:0;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;",
          "gap:6px;text-align:center;padding:24px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#88939c);",
          "font-family:var(--dsh-font-sans,system-ui,'Segoe UI','Microsoft YaHei',sans-serif)}",
          ".dsh-ct-empty b{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#eaf1f6)}",
          ".dsh-ct-empty span{max-width:420px;line-height:1.7}",
          "@media (max-width:1000px){.dsh-ct-top{grid-template-columns:1fr;gap:12px}}",
          "@media (max-width:760px){.dsh-ct{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}",
          ".dsh-ct-rail{border-right:0;border-bottom:1px solid rgba(255,255,255,.08);max-height:160px}}",
        ].join("");
        document.head.appendChild(style);
      } catch (error) { /* styling must never break the tab */ }
    }

    /* The 「压缩」 conversation tab: a master-detail timeline. Registered as a
     * conversation.view entry (order 1000 → appended after existing tabs) only
     * while the timeline is enabled and positioned to "tab". Reads the same
     * history sidecar as the gutter chain; the detail reuses the dsh-tl detail
     * classes so both surfaces stay visually identical. */
    function CompactionTabView(props) {
      ensureTimelineStyles();
      ensureCompactionTabStyles();
      var connection = props.connection;
      var sessionId = props.sessionId;

      var eventsState = React.useState([]);
      var events = eventsState[0], setEvents = eventsState[1];
      var selState = React.useState(-1);
      var selected = selState[0], setSelected = selState[1];
      var loadedState = React.useState(false);
      var loaded = loadedState[0], setLoaded = loadedState[1];

      React.useEffect(function () {
        if (!connection || !sessionId) return undefined;
        var alive = true;
        var timer;
        function poll() {
          fetchHistory(connection, sessionId).then(function (value) {
            if (!alive) return;
            var list = value && Array.isArray(value.events) ? value.events : [];
            setEvents(list);
            setLoaded(true);
            setSelected(function (current) {
              if (list.length === 0) return -1;
              return current < 0 || current >= list.length ? list.length - 1 : current;
            });
            timer = setTimeout(poll, 5000);
          }).catch(function () {
            if (!alive) return;
            setLoaded(true);
            timer = setTimeout(poll, 8000);
          });
        }
        poll();
        return function () { alive = false; if (timer !== undefined) clearTimeout(timer); };
      }, [connection, sessionId]);

      var palette = accentColor();
      var accent = palette.accent;

      // The host gives the view an auto-height wrapper, so `height:100%` would
      // grow with the document and scroll the rail/header out of view. Pin the
      // root to the measured space between the tab bar and the composer; then
      // only the document pane scrolls.
      React.useEffect(function () {
        function fit() {
          if (typeof document === "undefined") return;
          var root = document.querySelector("[data-dsh-handoff-compaction-tab]");
          if (!root) return;
          var top = root.getBoundingClientRect().top;
          var bottom = typeof window === "undefined" ? top + 500 : window.innerHeight;
          var content = document.querySelector("[data-conversation-content]");
          var box = content && content.getBoundingClientRect();
          if (box && box.height > 120) bottom = Math.min(bottom, box.bottom);
          var seat = document.querySelector("[data-composer-seat]");
          var seatBox = seat && seat.getBoundingClientRect();
          if (seatBox && seatBox.height > 0) bottom = Math.min(bottom, seatBox.top);
          var height = Math.max(200, Math.floor(bottom - top));
          root.style.height = height + "px";
        }
        fit();
        var timer = setTimeout(fit, 120);
        if (typeof window !== "undefined") window.addEventListener("resize", fit);
        return function () {
          clearTimeout(timer);
          if (typeof window !== "undefined") window.removeEventListener("resize", fit);
        };
      }, [events.length, index]);

      if (!loaded) {
        return h("div", { className: "dsh-ct-empty" }, h("span", null, "读取压缩记录中…"));
      }
      if (events.length === 0) {
        return h("div", { className: "dsh-ct-empty" },
          h("b", null, "还没有压缩记录"),
          h("span", null, "达到触发点或手动 /compact 后，这里会列出每次压缩的时间、用时与交接文档。")
        );
      }

      var index = selected >= 0 && selected < events.length ? selected : events.length - 1;
      var active = events[index];
      var before = Number(active.beforeTokens);
      var windowTokens = Number(active.contextWindow);
      var after = Number(active.afterTokens);
      var threshold = Number(active.thresholdTokens);
      var summaryTokens = Number(active.summaryTokens);
      var pctValue = before > 0 && windowTokens > 0 ? (before / windowTokens) * 100 : null;
      var ringSize = 84, ringR = ringSize / 2 - 7;
      var ringC = 2 * Math.PI * ringR, ringCenter = ringSize / 2;
      var filled = pctValue === null ? 0 : Math.max(0, Math.min(100, pctValue));
      var ring = h("figure", { className: "dsh-tl-ring" },
        h("svg", { viewBox: "0 0 " + ringSize + " " + ringSize, width: ringSize, height: ringSize, "aria-hidden": "true" },
          h("circle", { cx: ringCenter, cy: ringCenter, r: ringR, fill: "none", stroke: "rgba(241,75,11,.18)", strokeWidth: 7 }),
          h("circle", {
            cx: ringCenter, cy: ringCenter, r: ringR, fill: "none", stroke: accent, strokeWidth: 7, strokeLinecap: "round",
            strokeDasharray: (ringC * filled / 100).toFixed(1) + " " + ringC.toFixed(1),
            transform: "rotate(-90 " + ringCenter + " " + ringCenter + ")",
          })
        ),
        h("figcaption", null, pctValue === null ? "—" : pctValue.toFixed(1) + "%", h("small", null, "占窗口"))
      );
      var rows = [
        ["压缩用时", durationText(active.durationMs)],
        ["触发方式", active.trigger === "manual" ? "手动 /compact" : "自动（空闲时）"],
        ["交接文档", wordText(active)],
        ["摘要输出", Number.isFinite(summaryTokens) ? fmt(summaryTokens) + " tokens" : "—"],
        ["替换历史", (fmt(Number(active.shadowedNodes) || 0) + " 条 / " + fmt(Number(active.shadowedTokens) || 0) + " tokens")],
        ["模型", [active.provider, active.model].filter(Boolean).join(" · ") || "—"],
      ];

      var rail = h("aside", { className: "dsh-ct-rail" },
        h("div", { className: "dsh-ct-railhead" },
          h("span", { className: "dsh-ct-railtitle" }, "压缩事件"),
          h("span", { className: "dsh-ct-count" }, String(events.length))
        ),
        h("div", { className: "dsh-ct-tape" },
          events.map(function (event, i) {
            var chars = wordCount(event);
            var bead = Math.max(6, Math.min(12, 6 + Math.round(chars / 220)));
            return h("button", {
              key: String(event.startedAt || i),
              type: "button",
              className: "dsh-ct-ev" + (i === index ? " on" : ""),
              title: clockOf(event.startedAt) + " · " + durationText(event.durationMs) + " · " + fmt(chars) + " 字",
              onClick: function () { setSelected(i); },
            },
              h("span", { className: "dsh-ct-time" }, clockOf(event.startedAt)),
              h("span", { className: "dsh-ct-beadwrap" }, h("span", { className: "dsh-ct-bead", style: { width: bead + "px", height: bead + "px" } })),
              h("span", { className: "dsh-ct-meta" }, durationText(event.durationMs) + " · ", h("b", null, fmt(chars)), " 字")
            );
          })
        )
      );

      var detail = h("div", { className: "dsh-ct-detail" },
        h("div", { className: "dsh-ct-detailhead" },
          h("span", { className: "dsh-ct-detailtitle" }, "第 " + String(index + 1) + " 次压缩"),
          h("span", { className: "dsh-ct-stamp" }, dateOf(active.startedAt) + " · " + clockOf(active.startedAt) + " · " + (active.trigger === "manual" ? "手动 /compact" : "自动"))
        ),
        h("div", { className: "dsh-ct-top" },
          h("div", { className: "dsh-tl-hero" },
            ring,
            h("p", null,
              h("b", null, (Number.isFinite(before) ? fmt(before) : "—") + " tokens"),
              "触发时上下文",
              h("br"),
              "触发点阈值 " + (Number.isFinite(threshold) && threshold > 0 ? fmt(threshold) : "—"),
              h("br"),
              "压缩后 " + (Number.isFinite(after) ? fmt(after) : "—")
            )
          ),
          h("div", { className: "dsh-tl-rows" },
            rows.map(function (row) {
              return h("div", { className: "dsh-tl-row", key: row[0] }, h("span", null, row[0]), h("b", null, row[1]));
            })
          )
        ),
        h("div", { className: "dsh-tl-doctitle" }, h("b", null, "交接文档全文"), h("span", null, wordText(active))),
        h("pre", { className: "dsh-tl-doc" }, String(active.summary || "（本次未记录交接文档）")),
        h("p", { className: "dsh-tl-note" }, "字数与时长为插件本地计算；tokens 取 DSH usage 与摘要调用 usage，不额外消耗模型算力。")
      );

      return h("div", {
        className: "dsh-ct",
        "data-dsh-handoff-compaction-tab": "1",
        style: { "--dsh-ct-accent": accent, "--dsh-ct-bead": palette.bead },
      }, rail, detail);
    }

    function Section(props) {
      var connection = props.connection;
      var loaded = React.useState(null);
      var settings = loaded[0], setSettings = loaded[1];
      var draftState = React.useState(null);
      var draft = draftState[0], setDraft = draftState[1];
      var statusState = React.useState({ loading: true, error: "", saving: false, saved: false });
      var status = statusState[0], setStatus = statusState[1];
      var scopeState = React.useState({ loading: true, error: "", value: null });
      var scope = scopeState[0], setScope = scopeState[1];
      var tokenState = React.useState(0);
      var token = tokenState[0], setToken = tokenState[1];
      var capState = React.useState(null);
      var capDraft = capState[0], setCapDraft = capState[1];
      ensureStatusStyles();

      // Which presets exist and which of them this plugin's patch reaches is
      // DSH's answer, not ours, so it is read fresh each time the section opens.
      React.useEffect(function () {
        if (!connection) {
          setScope({ loading: false, error: "连接服务不可用", value: null });
          return undefined;
        }
        var alive = true;
        setScope(function (previous) { return { loading: true, error: "", value: previous.value }; });
        call(connection, "scope").then(function (value) {
          if (!alive) return;
          rememberPresetLabels(value && Array.isArray(value.presets) ? value.presets : []);
          setScope({ loading: false, error: "", value: value });
        }).catch(function (error) {
          if (alive) setScope({ loading: false, error: String(error && error.message || error), value: null });
        });
        return function () { alive = false; };
      }, [connection, token]);

      React.useEffect(function () {
        var alive = true;
        if (!connection) { setStatus({ loading: false, error: "连接服务不可用", saving: false, saved: false }); return; }
        call(connection, "get").then(function (value) {
          if (!alive) return;
          setSettings(value); setDraft(value);
          publishDisplayStyle(value && value.displayStyle);
          publishTimelinePrefs(value);
          setStatus({ loading: false, error: "", saving: false, saved: false });
        }).catch(function (error) {
          if (alive) setStatus({ loading: false, error: String(error && error.message || error), saving: false, saved: false });
        });
        return function () { alive = false; };
      }, [connection]);

      if (status.loading) return h("div", { style: { color: C.muted, padding: 18, fontSize: 13 } }, "读取设置中…");
      if (status.error && !draft) return h("div", { style: { color: "var(--dsw-alias-state-warn-primary, #e0b341)", padding: 18, fontSize: 13, lineHeight: 1.8 } }, "无法读取设置：" + status.error);

      var base = draft || { enabled: true, thresholdRatio: 0.9, scope: "global", presets: [], templateFile: "", displayStyle: "orbit", midTaskEnabled: false, midTaskTriggerTokens: MID_TASK_MIN_TRIGGER, suppressFailureHint: false };
      var enabled = base.enabled !== false;
      var ratio = Math.round((Number(base.thresholdRatio) || 0.9) * 100);
      var scopePreset = base.scope === "preset";
      var presets = Array.isArray(base.presets) ? base.presets : [];
      var template = base.templateFile || "";
      var defaultTemplate = base.defaultTemplate || DEFAULT_TEMPLATE;
      var themeStyle = normalizeDisplayStyle(base.displayStyle);
      var tlEnabled = base.timelineEnabled !== false;
      var tlPosition = normalizeTimelinePosition(base.timelinePosition);
      var midEnabled = base.midTaskEnabled === true;
      var midRaw = Number(base.midTaskTriggerTokens);
      var midValue = Number.isFinite(midRaw)
        ? Math.max(MID_TASK_MIN_TRIGGER, Math.min(MID_TASK_EXAMPLE_MAX, Math.floor(midRaw)))
        : MID_TASK_MIN_TRIGGER;
      var hintOn = base.suppressFailureHint !== true;
      var capDefaultRaw = Number(base.defaultSummaryMaxTokens);
      var capDefault = Number.isFinite(capDefaultRaw) && capDefaultRaw >= 1 ? Math.floor(capDefaultRaw) : 20000;
      var capText = capDraft === null ? (base.summaryMaxTokens !== undefined ? String(base.summaryMaxTokens) : String(capDefault)) : capDraft;
      var capTrim = capText.trim();
      var capParsed = capTrim === "" ? undefined : (/^\d+$/.test(capTrim) ? Number(capTrim) : NaN);
      var capError = capTrim === "" ? ""
        : !Number.isInteger(capParsed) ? "请输入整数 tokens。"
          : capParsed < 8192 ? "最低 8,192 tokens：再小摘要装不下模板小节，会反复触发续写。" : "";
      var capValue = capError !== "" || capParsed === undefined || capParsed === capDefault ? undefined : capParsed;
      var capMessage = capError !== "" ? capError
        : capTrim === "" ? "留空 = 恢复默认 " + fmt(capDefault) + " tokens。"
          : "下一次压缩生效：单次摘要上限 " + fmt(capParsed) + " tokens。";

      /* Only presets the takeover rows reach can be selected; the rest stay
       * native and would be misleading to offer. */
      var takeable = scope.value && Array.isArray(scope.value.presets)
        ? scope.value.presets.filter(function (p) { return p && p.covered === true; })
        : [];

      var budget = EXAMPLE_WINDOW - EXAMPLE_RESERVED;
      var ceiling = budget - EXAMPLE_HEADROOM;
      var eff = Math.min(Math.round(budget * ratio / 100), ceiling);
      var capped = Math.round(budget * ratio / 100) > ceiling;
      // Water-level illustration for the settings example: used head, the
      // verbatim tail the selector keeps, and the trigger line.
      var midUsed = EXAMPLE_WINDOW - midValue;
      var midUsedPct = midUsed / EXAMPLE_WINDOW * 100;
      var midTailPct = ((EXAMPLE_WINDOW - EXAMPLE_RESERVED) * 0.16) / EXAMPLE_WINDOW * 100;
      var dirty = settings === null || (settings.enabled !== false) !== enabled ||
        Math.round((settings.thresholdRatio || 0.9) * 100) !== ratio ||
        settings.scope !== base.scope ||
        JSON.stringify(settings.presets || []) !== JSON.stringify(presets) ||
        (settings.templateFile || "") !== template ||
        normalizeDisplayStyle(settings.displayStyle) !== themeStyle ||
        (settings.timelineEnabled !== false) !== tlEnabled ||
        normalizeTimelinePosition(settings.timelinePosition) !== tlPosition ||
        (settings.midTaskEnabled === true) !== midEnabled ||
        (Number(settings.midTaskTriggerTokens) || MID_TASK_MIN_TRIGGER) !== midValue ||
        (settings.suppressFailureHint === true) !== !hintOn ||
        (settings.summaryMaxTokens ?? undefined) !== capValue;

      // Every field is read from disk at decision time, so an unsaved edit says
      // nothing has happened yet: mark just that field 保存后生效.
      var saved = settings;
      var scopeIsPending = saved !== null && (saved.scope === "preset") !== scopePreset;
      var presetsIsPending = saved !== null && scopePreset &&
        JSON.stringify(presets.slice().sort()) !== JSON.stringify((saved.presets || []).slice().sort());
      var pending = {
        enabled: saved !== null && (saved.enabled !== false) !== enabled,
        scope: scopeIsPending || presetsIsPending,
        display: saved !== null && normalizeDisplayStyle(saved.displayStyle) !== themeStyle,
        timeline: saved !== null && (saved.timelineEnabled !== false) !== tlEnabled,
        position: saved !== null && normalizeTimelinePosition(saved.timelinePosition) !== tlPosition,
        midTask: saved !== null && (saved.midTaskEnabled === true) !== midEnabled,
        midTrigger: saved !== null && (Number(saved.midTaskTriggerTokens) || MID_TASK_MIN_TRIGGER) !== midValue,
        hint: saved !== null && (saved.suppressFailureHint === true) !== !hintOn,
        ratio: saved !== null && Math.round((saved.thresholdRatio || 0.9) * 100) !== ratio,
        cap: saved !== null && (saved.summaryMaxTokens ?? undefined) !== capValue,
        template: saved !== null && (saved.templateFile || "") !== template,
      };
      var pendingTag = function (on) {
        return on ? h("span", { "aria-live": "polite", style: pendingStyle }, "（保存后生效）") : null;
      };

      function patch(next) { setDraft(Object.assign({}, base, next)); setStatus({ loading: false, error: "", saving: false, saved: false }); }
      function setPreset(id) {
        var next = presets.indexOf(id) >= 0 ? presets.filter(function (v) { return v !== id; }) : presets.concat([id]);
        patch({ presets: next });
      }
      function save() {
        setStatus({ loading: false, error: "", saving: true, saved: false });
        call(connection, "set", {
          enabled: enabled,
          thresholdRatio: ratio,
          scope: scopePreset ? "preset" : "global",
          presets: presets,
          templateFile: template,
          displayStyle: themeStyle,
          timelineEnabled: tlEnabled,
          timelinePosition: tlPosition,
          midTaskEnabled: midEnabled,
          midTaskTriggerTokens: midValue,
          suppressFailureHint: !hintOn,
          summaryMaxTokens: capValue,
        }).then(function (value) {
          setSettings(value); setDraft(value);
          setCapDraft(null);
          publishDisplayStyle(value && value.displayStyle);
          publishTimelinePrefs(value);
          setStatus({ loading: false, error: "", saving: false, saved: true });
          setToken(token + 1);
        }).catch(function (error) {
          setStatus({ loading: false, error: String(error && error.message || error), saving: false, saved: false });
        });
      }

      function discard() { setDraft(settings); setCapDraft(null); setStatus({ loading: false, error: "", saving: false, saved: false }); }
      function open(kind) {
        call(connection, "open", { kind: kind, path: template }).then(function () {
          setStatus({ loading: false, error: "", saving: false, saved: false, note: "已打开" });
        }).catch(function (error) {
          setStatus({ loading: false, error: String(error && error.message || error), saving: false, saved: false });
        });
      }

      var rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "14px 0", borderBottom: "1px solid " + C.line };
      var labelStyle = { fontSize: 13.5, fontWeight: 600, color: C.text };
      var subStyle = { fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.6 };
      var btnBase = { border: "1px solid " + C.line, background: "transparent", color: C.text, fontSize: 12, padding: "6px 11px", borderRadius: 7, cursor: "pointer", font: "inherit", whiteSpace: "nowrap" };
      var btnPrimary = Object.assign({}, btnBase, { borderColor: "transparent", background: C.accent, color: "#fff", fontWeight: 600 });
      var seg = function (active, label, onClick) {
        return h("button", {
          type: "button", onClick: onClick,
          style: { border: 0, cursor: "pointer", font: "inherit", fontSize: 12.5, padding: "7px 14px", background: active ? C.accentSoft : "transparent", boxShadow: active ? "inset 0 0 0 1px " + C.accentLine : "none", color: active ? C.text : C.muted, fontWeight: active ? 600 : 400, whiteSpace: "nowrap" },
        }, label);
      };

      var offBadgeStyle = { marginLeft: 6, fontSize: 10.5, color: C.muted, background: "rgba(127,133,140,.14)", border: "1px solid " + C.line, borderRadius: 999, padding: "0 6px", lineHeight: "16px", fontWeight: 400 };
      var pendingStyle = { marginLeft: 8, fontSize: 11.5, fontWeight: 400, color: C.error };

      return h("div", { className: "dac-section", style: { display: "flex", flexDirection: "column", paddingBottom: 12 } },

        h("div", { style: rowStyle },
          h("div", null,
            h("div", { style: labelStyle }, "启用插件", pendingTag(pending.enabled), !enabled ? h("span", { style: offBadgeStyle }, "已停用") : null),
            h("div", { style: subStyle }, enabled
              ? "达到触发点后，等 agent 空闲时把历史折叠成一份交接文档；压缩由本插件接管。"
              : "关闭后压缩交回 DSH 原生实现：按原生阈值自动折叠，也可继续用 /compact 手动压缩。")
          ),
          h(ToggleSwitch, {
            checked: enabled,
            label: "启用插件",
            onChange: function (value) { patch({ enabled: value }); },
          })
        ),

        h("div", { style: rowStyle },
          h("div", null,
            h("div", { style: labelStyle }, "生效范围", pendingTag(pending.scope)),
            h("div", { style: subStyle }, scopePreset ? "只有勾选的预设由插件压缩，其余预设保持 DSH 自带行为" : "所有能被本插件接入的预设都由插件压缩，共用这份设置")
          ),
          h("div", { style: { display: "inline-flex", flex: "0 0 auto", border: "1px solid " + C.line, borderRadius: 8, overflow: "hidden" } },
            seg(!scopePreset, "全局", function () { patch({ scope: "global" }); }),
            seg(scopePreset, "预设", function () { patch({ scope: "preset" }); })
          )
        ),
        scopePreset ? h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", padding: "10px 0", borderBottom: "1px solid " + C.line } },
          takeable.length === 0
            ? h("span", { style: subStyle }, scope.loading
              ? "正在向 DSH 读取预设名单…"
              : scope.error || (scope.value && scope.value.reason)
                ? "读取预设名单失败：" + (scope.error || scope.value.reason) + "。重新打开本页会再读一次。"
                : "本插件还没接入任何预设。重启一次 DSH 会重新接入；仍未出现预设名单说明 DSH 没有返回预设。")
            : takeable.map(function (p) {
                var on = presets.indexOf(p.id) >= 0;
                return h("button", {
                  key: p.id, type: "button", onClick: function () { setPreset(p.id); },
                  style: { fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer", font: "inherit", border: "1px solid " + (on ? C.accentLine : C.line), background: on ? C.accentSoft : "transparent", color: on ? C.text : C.muted },
                }, presetLabel(p.id));
              })
        ) : null,

        h("div", { style: { padding: "12px 0", borderBottom: "1px solid " + C.line } },
          h("div", null,
            h("div", { style: labelStyle }, "压缩显示方式", pendingTag(pending.display)),
            h("div", { style: subStyle }, "选择压缩进行时在会话里的提示样式；保存后下一次压缩生效。")
          ),
          h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", padding: 3, border: "1px solid " + C.line, borderRadius: 8, background: "transparent", width: "fit-content", maxWidth: "100%", marginTop: 9 } },
            DISPLAY_OPTIONS.map(function (option) {
              var on = themeStyle === option.id;
              return h("button", {
                key: option.id, type: "button",
                onClick: function () { patch({ displayStyle: option.id }); },
                "aria-pressed": on ? "true" : "false",
                style: { display: "inline-flex", alignItems: "center", gap: 6, height: 30, padding: "0 10px", border: 0, borderRadius: 6, background: on ? C.accentSoft : "transparent", boxShadow: on ? "inset 0 0 0 1px " + C.accentLine : "none", color: on ? C.text : C.muted, cursor: "pointer", font: "inherit", fontSize: 12.5, fontWeight: on ? 600 : 400, whiteSpace: "nowrap" },
              }, h("span", { className: "dsh-handoff-opt dsh-handoff-opt-" + option.id, "aria-hidden": "true" }), option.label);
            })
          ),
          h(ThemePreview, { theme: themeStyle })
        ),

        h("div", { style: { padding: "12px 0", borderBottom: "1px solid " + C.line } },
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 } },
            h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
              h("div", { style: labelStyle }, "任务中途压缩", pendingTag(pending.midTask || pending.midTrigger)),
              h("div", { style: subStyle }, midEnabled
                ? "每一步开始前测一次余量；低于触发余量就先折叠历史，再继续当前任务。"
                : "默认关闭：只在任务结束后压缩。开启后每一步开始前测一次余量，不足就先压缩再继续。")
            ),
            h(ToggleSwitch, {
              checked: midEnabled,
              label: "任务中途压缩",
              onChange: function (value) { patch({ midTaskEnabled: value }); },
            })
          ),
          midEnabled ? h("div", { style: { marginTop: 11 } },
            h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 6 } },
              h("span", null, "示例窗口 " + fmt(EXAMPLE_WINDOW) + " tokens"),
              h("span", { style: { color: C.warn, fontWeight: 600 } }, "触发线 · 已用 " + fmt(midUsed))
            ),
            h("div", { style: { position: "relative", display: "flex", height: 24, border: "1px solid " + C.line, borderRadius: 7, overflow: "hidden", background: C.field } },
              h("div", { style: { width: Math.max(0, midUsedPct - midTailPct).toFixed(2) + "%", background: "linear-gradient(90deg, rgba(76,141,255,.20), rgba(76,141,255,.44))", borderRight: "1px solid " + C.accentLine } }),
              h("div", { style: { width: midTailPct.toFixed(2) + "%", background: "repeating-linear-gradient(135deg, rgba(127,133,140,.22) 0 4px, transparent 4px 9px)" } }),
              h("div", { style: { flex: "1 1 auto" } }),
              h("div", { style: { position: "absolute", top: -3, bottom: -3, left: midUsedPct.toFixed(2) + "%", width: 2, background: C.warn, borderRadius: 1 } })
            ),
            h("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 10.5, color: C.faint } },
              h("span", null, "已用 " + fmt(midUsed)),
              h("span", null, "逐字保留尾部 ≈ " + fmt(Math.round((EXAMPLE_WINDOW - EXAMPLE_RESERVED) * 0.16))),
              h("span", null, "触发余量 " + fmt(midValue)),
              h("span", null, "窗口 " + fmt(EXAMPLE_WINDOW))
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: 12, marginTop: 10 } },
              h("input", {
                type: "range",
                min: MID_TASK_MIN_TRIGGER,
                max: MID_TASK_EXAMPLE_MAX,
                step: 1000,
                value: midValue,
                "aria-label": "任务中途压缩触发余量",
                style: { flex: "1 1 auto", maxWidth: 340, accentColor: C.accent },
                onChange: function (e) { patch({ midTaskTriggerTokens: Number(e.target.value) }); },
              }),
              h("span", { style: { fontSize: 12.5, color: C.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } },
                fmt(midValue),
                h("span", { style: { color: C.faint, marginLeft: 4, fontSize: 11 } }, "tokens")
              )
            ),
            h("div", { style: { display: "flex", justifyContent: "space-between", maxWidth: 420, fontSize: 10.5, color: C.faint, marginTop: 2 } },
              h("span", null, "20,000 最低"),
              h("span", null, fmt(MID_TASK_EXAMPLE_MAX) + " 窗口一半")
            ),
            h("div", { style: { marginTop: 8, fontSize: 11.5, color: C.muted, lineHeight: 1.7 } },
              "剩余 ≤ " + fmt(midValue) + " 时压缩 ≈ 已用 " + fmt(midUsed) + " / " + fmt(EXAMPLE_WINDOW) +
              "。实际窗口按当前模型读取，上限自动钳到窗口一半；压缩发生在两步之间，不打断任务。")
          ) : h("div", { style: { marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "rgba(210,153,34,.12)", border: "1px solid rgba(210,153,34,.34)", fontSize: 11.5, color: C.muted, lineHeight: 1.65 } },
            "只等任务结束再压缩，就可能出现「最后一轮几乎用尽窗口、写摘要反而没有余量」的情况；开启本项可把压缩提前到两步之间。")
        ),

        h("div", { style: rowStyle },
          h("div", null,
            h("div", { style: labelStyle }, "压缩失败提示", pendingTag(pending.hint)),
            h("div", { style: subStyle }, "因余量不足压缩失败时，在窗口中间说明原因，并引导开启或调高「任务中途压缩」；关闭后不再弹窗，失败仍会记入状态。")
          ),
          h(ToggleSwitch, {
            checked: hintOn,
            label: "压缩失败提示",
            onChange: function (value) { patch({ suppressFailureHint: !value }); },
          })
        ),

        h("div", { style: { padding: "12px 0", borderBottom: "1px solid " + C.line } },
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 } },
            h("div", null,
              h("div", { style: labelStyle }, "压缩时间线", pendingTag(pending.timeline)),
              h("div", { style: subStyle }, tlEnabled
                ? "把每次压缩的时间、用时和字数显示在会话里，点击可查看交接文档全文。"
                : "已关闭：不显示时间线，也不新增「压缩」页签；压缩历史仍会记录在磁盘上。")
            ),
            h(ToggleSwitch, {
              checked: tlEnabled,
              label: "压缩时间线",
              onChange: function (value) { patch({ timelineEnabled: value }); },
            })
          ),
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginTop: 11, opacity: tlEnabled ? 1 : 0.4 } },
            h("span", { style: { fontSize: 12.5, color: C.text, fontWeight: 500 } }, "显示位置", pendingTag(pending.position)),
            h("div", { style: { display: "inline-flex", flex: "0 0 auto", border: "1px solid " + C.line, borderRadius: 8, overflow: "hidden" } },
              [["chat", "对话区域"], ["tab", "压缩页签"]].map(function (opt) {
                var on = tlPosition === opt[0];
                return h("button", {
                  key: opt[0], type: "button",
                  disabled: !tlEnabled,
                  "aria-pressed": on ? "true" : "false",
                  onClick: function () { if (tlEnabled) patch({ timelinePosition: opt[0] }); },
                  style: { border: 0, cursor: tlEnabled ? "pointer" : "not-allowed", font: "inherit", fontSize: 12.5, padding: "7px 14px", background: on ? C.accentSoft : "transparent", boxShadow: on ? "inset 0 0 0 1px " + C.accentLine : "none", color: on ? C.text : C.muted, fontWeight: on ? 600 : 400, whiteSpace: "nowrap" },
                }, opt[1]);
              })
            )
          ),
          h("div", { style: Object.assign({}, subStyle, { marginTop: 7 }) }, tlEnabled
            ? (tlPosition === "chat"
              ? "珠链挂在「对话」正文左侧空槽，随会话常驻；切到「轨迹」自动隐藏。"
              : "在「轨迹」和其它插件页签之后追加「压缩」页签，不占固定位置；集中浏览压缩记录与交接文档。")
            : "时间线已关闭，显示位置暂不生效。"),
          h("div", { style: { fontSize: 11.5, color: C.faint, marginTop: 8 } }, "保存后即时生效，无需重启；关闭仅隐藏显示，压缩历史仍会记录在磁盘上。")
        ),

        h("div", { style: rowStyle },
          h("div", null,
            h("div", { style: labelStyle }, "压缩触发点", pendingTag(pending.ratio)),
            h("div", { style: subStyle }, "上下文占用达到这个比例后，等当前这轮回答结束再压缩")
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
            h("input", {
              type: "range", min: 0, max: 100, step: 1, value: ratio, "aria-label": "压缩触发点",
              style: { width: 220, accentColor: C.accent },
              onChange: function (e) { patch({ thresholdRatio: snapPercent(e.target.value) / 100 }); },
            }),
            h("div", { style: { display: "flex", alignItems: "center", border: "1px solid " + C.line, borderRadius: 8, background: C.field, height: 32, overflow: "hidden" } },
              h("input", {
                type: "number", min: 0, max: 100, value: ratio, "aria-label": "压缩触发点百分比",
                style: { width: 52, height: 30, border: 0, background: "transparent", color: C.text, textAlign: "right", padding: "0 4px 0 10px", fontSize: 13, outline: "none" },
                onChange: function (e) {
                  var raw = e.target.value;
                  if (raw === "") return;
                  patch({ thresholdRatio: clampPercent(raw) / 100 });
                },
              }),
              h("span", { style: { color: C.muted, fontSize: 12, padding: "0 9px 0 2px" } }, "%")
            )
          )
        ),
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "10px 0", borderBottom: "1px solid " + C.line } },
          h("div", { style: subStyle },
            "示例：窗口 250K、主回复预留 20K、安全余量 10K → 可用预算 " + fmt(budget) + "；" + ratio + "% ≈ " + fmt(eff) + " tokens" +
            (capped ? "（已封顶，再往上不会更晚触发）" : "（距输入上限余 " + fmt(budget - eff) + "）")
          ),
          h("div", { style: { fontSize: 20, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" } }, ratio + "%")
        ),

        h("div", { style: { padding: "14px 0", borderBottom: "1px solid " + C.line } },
          h("div", { style: labelStyle }, "摘要上限", pendingTag(pending.cap)),
          h("div", { style: Object.assign({}, subStyle, { marginTop: 6, marginBottom: 10 }) },
            "单次摘要生成的输出上限，默认 " + fmt(capDefault) + " tokens；最低 8,192，留空恢复默认。写到上限后会自动续写或重写，各自独立预算。"),
          h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
            h("div", { style: { display: "flex", alignItems: "center", border: "1px solid " + (capError ? C.error : C.line), borderRadius: 8, background: C.field, height: 34, overflow: "hidden", width: 190 } },
              h("input", {
                type: "text", inputMode: "numeric", value: capText, "aria-label": "摘要上限 tokens",
                onChange: function (e) { setCapDraft(e.target.value); },
                style: { flex: 1, minWidth: 0, border: 0, background: "transparent", color: C.text, padding: "0 10px", fontSize: 13.5, outline: "none", fontFamily: "ui-monospace,Consolas,monospace" },
              }),
              h("span", { style: { color: C.muted, fontSize: 12, padding: "0 9px 0 2px" } }, "tokens")
            ),
            h("button", { type: "button", style: btnBase, onClick: function () { setCapDraft(String(capDefault)); } }, "恢复默认")
          ),
          h("div", { style: { marginTop: 8, fontSize: 11.5, lineHeight: 1.6, color: capError ? C.error : capTrim === "" ? C.muted : C.ok } }, capMessage)
        ),

        h("div", { style: { paddingTop: 14 } },
          h("div", { style: labelStyle }, "交接模板", pendingTag(pending.template)),
          h("div", { style: Object.assign({}, subStyle, { marginBottom: 8 }) }, "压缩时让模型按这份模板写交接文档；每次压缩时读取，改完不用重启。此插件模板完全基于 DSH 原生压缩模板的中文翻译版，若需要撤销自己的修改，只需要从磁盘删除该模板文件，然后重启 DSH，模板会自动重建。"),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, background: C.field, border: "1px solid " + C.line, borderRadius: 8, padding: "7px 10px" } },
            h("input", {
              value: template, placeholder: defaultTemplate, "aria-label": "模板文件路径",
              onChange: function (e) { patch({ templateFile: e.target.value }); },
              style: { flex: 1, border: 0, background: "transparent", color: C.text, fontFamily: "ui-monospace,Consolas,monospace", fontSize: 12, outline: "none" },
            }),
            h("button", { type: "button", style: btnBase, onClick: function () { open("file"); } }, "打开文件"),
            h("button", { type: "button", style: btnBase, onClick: function () { open("folder"); } }, "所在文件夹")
          ),
          h("div", { style: { marginTop: 8, fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
            "留空使用默认路径；文件不存在时引擎会按内置模板生成一份。")
        ),

        h("div", { style: { marginTop: 14, background: C.panel, border: "1px solid " + C.line, borderRadius: 10, padding: "14px 16px" } },
          h("div", { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginBottom: 8 } }, "它是怎么压缩的"),
          h("ol", { style: { margin: 0, paddingLeft: 18, color: C.muted, fontSize: 12.5, lineHeight: 1.85 } },
            h("li", null, "到点后不立即动手，等 agent 结束当前回合。"),
            h("li", null, "写交接文档时会复用会话已算过的上下文（命中缓存），不重新全量计算历史。"),
            h("li", null, "只替换最旧的这一段历史，换成一条交接文档；最近约 16% 窗口的原文逐字留着，切点也不会把工具调用和它的结果拆开。"),
            h("li", null, "下一轮 = 系统提示词 + 工具定义 + 这条交接文档 + 那段逐字保留的最近消息；旧消息仍在会话日志里，可用回滚功能恢复。")
          ),
          h("div", { style: { marginTop: 8, fontSize: 11.5, color: C.faint } }, "手动压缩：会话里发送 /compact 可随时折叠一次，不受这个比例限制。")
        ),

        h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 14 } },
          h("button", { type: "button", style: dirty && capError === "" ? btnPrimary : Object.assign({}, btnBase, { opacity: 0.55 }), onClick: dirty && capError === "" ? save : undefined }, status.saving ? "保存中…" : "保存"),
          h("button", { type: "button", style: btnBase, onClick: discard }, "撤销改动"),
          status.note ? h("span", { style: { fontSize: 12, color: C.ok } }, status.note) : status.saved ? h("span", { style: { fontSize: 12, color: C.ok } }, "已保存，下次判定生效") : null,
          status.error ? h("span", { style: { fontSize: 12, color: C.error } }, status.error) : null
        )
      );
    }

    function apply(ctx) {
      var slots = ctx.slots;
      var connection = ctx.connection;

      try {
        slots.inject("settings.section", function () {
          return slots.register({
            name: "settings.section",
            id: "auto-compaction",
            order: 14,
            label: function () { return "会话压缩"; },
            inject: function () { return {}; },
          }, function SectionView() { return h(Section, { connection: connection }); });
        });
      } catch (error) {
        console.warn("[handoff-ui] settings section registration failed", error);
      }

      try {
        var sessions;
        try { sessions = ctx.sessions; } catch (error) { sessions = undefined; }
        if (!sessions && typeof ctx.get === "function") {
          try { sessions = ctx.get("sessions"); } catch (error) { sessions = undefined; }
        }
        function cancelFor(sessionId) {
          if (!sessions || typeof sessions.scope !== "function") return undefined;
          try {
            var scope = sessions.scope(sessionId);
            if (!scope || typeof scope.get !== "function") return undefined;
            var conversation = scope.get("conversation");
            if (!conversation || typeof conversation.cancel !== "function") return undefined;
            return function () { return conversation.cancel(); };
          } catch (error) {
            return undefined;
          }
        }
        slots.inject("conversation.input.dock", function () {
          return slots.register({
            name: "conversation.input.dock",
            id: "auto-compaction-status",
            order: 10,
            inject: function (sessionId) {
              return { sessionId: sessionId, cancel: cancelFor(sessionId) };
            },
          }, function StatusDockView(slotProps) {
            return h(React.Fragment, null,
              h(StatusDock, {
                connection: connection,
                sessionId: slotProps.sessionId,
                cancel: slotProps.cancel,
              }),
              h(TimelineDock, {
                connection: connection,
                sessionId: slotProps.sessionId,
              }),
              h(FailureHint, {
                connection: connection,
                sessionId: slotProps.sessionId,
              })
            );
          });
        });
      } catch (error) {
        console.warn("[handoff-ui] status dock registration failed", error);
      }

      try {
        slots.inject("conversation.view", function () {
          var registration = null;
          function sync() {
            var want = timelinePrefs.enabled && timelinePrefs.position === "tab";
            if (want && registration === null) {
              registration = slots.register({
                name: "conversation.view",
                id: "auto-compaction-timeline",
                // Appended after the existing tabs (chat 0, trajectory 10, …),
                // never a fixed slot index, so other plugins' tabs keep their place.
                order: 1000,
                label: function () { return "压缩"; },
                inject: function (sessionId) { return { sessionId: sessionId }; },
              }, function CompactionView(slotProps) {
                return h(CompactionTabView, { connection: connection, sessionId: slotProps.sessionId });
              });
            } else if (!want && registration !== null) {
              registration();
              registration = null;
            }
          }
          var unsubscribe = subscribeTimelinePrefs(sync);
          loadTimelinePrefs(connection);
          sync();
          return function () {
            unsubscribe();
            if (registration !== null) { registration(); registration = null; }
          };
        });
      } catch (error) {
        console.warn("[handoff-ui] compaction tab registration failed", error);
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // Exposed for the structure test: renders the tab view with a fake React.
    exports.CompactionTabView = CompactionTabView;
    exports.Section = Section;
    exports.FailureHint = FailureHint;
    return module.exports;
  },
});
