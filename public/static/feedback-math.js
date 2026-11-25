/* Рендеринг формул в ответах к домашним заданиям. */
(function () {
  "use strict";

  const delimiters = /(\*\*|)(?:(\\{1,2})\(([\s\S]+?)\2\)|(\\{1,2})\[([\s\S]+?)\4\]|\$\$([\s\S]+?)\$\$|\$(?![\s$])([^$\r\n]+?)\$(?![\d$]))\1/g;
  const latest = new WeakMap();
  let loading;

  function loadKatex() {
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/static/vendor/katex-0.19.1.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    return loading;
  }

  function render(element, text, formatText) {
    latest.set(element, text);
    const formulas = Array.from(text.matchAll(delimiters)).filter(match =>
      match[7] === undefined || text[match.index - 1] !== "\\");
    if (!formulas.length) return false;

    function paint() {
      let html = "", end = 0;
      for (const match of formulas) {
        const [original, , inlineSlash, inline, displaySlash, display, block, dollar] = match;
        let formula = (inline ?? display ?? block ?? dollar).trim();
        if ((inlineSlash || displaySlash)?.length === 2) formula = formula.replace(/\\\\/g, "\\");
        html += formatText(text.slice(end, match.index));
        try {
          html += window.katex.renderToString(formula, {
            output: "mathml",
            displayMode: display !== undefined || block !== undefined,
            trust: false,
            strict: "ignore",
            maxSize: 20,
            maxExpand: 600,
          });
        } catch (_) {
          html += formatText(original);
        }
        end = match.index + original.length;
      }
      element.innerHTML = html + formatText(text.slice(end));
    }

    if (window.katex) paint();
    else {
      element.innerHTML = formatText(text);
      loadKatex().then(() => {
        if (element.isConnected && latest.get(element) === text) paint();
      }, () => { loading = null; });
    }
    return true;
  }

  window.feedbackMath = { render };
})();
