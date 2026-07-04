/**
 * Stateful stream text normalizer ported from Python (format_normalizer.py)
 * Translates LaTeX math notation and ASCII arrows to clean Unicode characters
 * outside code blocks (both triple backtick and inline single backtick blocks).
 */
export class StreamingTextNormalizer {
  constructor() {
    this.buffer = "";
    this.inCodeBlock = false;
    this.inInlineCode = false;
  }

  feed(chunk) {
    if (!chunk) return "";
    this.buffer += chunk;

    let cutOff = this.buffer.length;

    // 1. LaTeX command cut-off (buffer ends with \ followed by letters, wait for it to complete)
    const matchLatex = /\\[a-zA-Z]*$/.exec(this.buffer);
    if (matchLatex) {
      cutOff = matchLatex.index;
    }

    // 2. HTML entity cut-off (buffer ends with & followed by letters/digits, wait for it to complete)
    const matchHtml = /&[a-zA-Z0-9#]*$/.exec(this.buffer);
    if (matchHtml) {
      cutOff = Math.min(cutOff, matchHtml.index);
    }

    // 3. Arrow or code block delimiter cut-off
    for (const pref of ["-", "=", "`", "``"]) {
      if (this.buffer.endsWith(pref)) {
        cutOff = Math.min(cutOff, this.buffer.length - pref.length);
        break;
      }
    }

    const toProcess = this.buffer.substring(0, cutOff);
    this.buffer = this.buffer.substring(cutOff);

    return this._processText(toProcess);
  }

  flush() {
    const res = this.buffer;
    this.buffer = "";
    return this._processText(res);
  }

  _processText(text) {
    const output = [];
    let i = 0;
    const n = text.length;

    while (i < n) {
      // 1. Check for backticks (to toggle code block state)
      if (text[i] === '`') {
        let count = 0;
        while (i + count < n && text[i + count] === '`') {
          count++;
        }
        const backticks = text.substring(i, i + count);
        i += count;

        if (count >= 3) {
          this.inCodeBlock = !this.inCodeBlock;
          this.inInlineCode = false;
        } else if (count === 1) {
          if (!this.inCodeBlock) {
            this.inInlineCode = !this.inInlineCode;
          }
        }
        output.push(backticks);
        continue;
      }

      // If inside code blocks, copy characters as-is
      if (this.inCodeBlock || this.inInlineCode) {
        output.push(text[i]);
        i++;
        continue;
      }

      // 2. Check for LaTeX commands starting with \
      if (text[i] === '\\') {
        // Handle \sqrt{...}
        if (text.startsWith("\\sqrt{", i)) {
          let depth = 1;
          let j = i + 6;
          let found = false;
          while (j < n) {
            if (text[j] === '{') {
              depth++;
            } else if (text[j] === '}') {
              depth--;
              if (depth === 0) {
                found = true;
                break;
              }
            }
            j++;
          }
          if (found) {
            const inside = text.substring(i + 6, j);
            const normalizedInside = this._processText(inside);
            output.push(`√${normalizedInside}`);
            i = j + 1;
            continue;
          } else {
            // Incomplete matching brace, wait
            break;
          }
        }

        // Handle \frac{...}{...}
        if (text.startsWith("\\frac{", i)) {
          let depth = 1;
          let j = i + 6;
          let found1 = false;
          while (j < n) {
            if (text[j] === '{') {
              depth++;
            } else if (text[j] === '}') {
              depth--;
              if (depth === 0) {
                found1 = true;
                break;
              }
            }
            j++;
          }
          if (found1) {
            if (j + 1 < n && text[j + 1] === '{') {
              depth = 1;
              let k = j + 2;
              let found2 = false;
              while (k < n) {
                if (text[k] === '{') {
                  depth++;
                } else if (text[k] === '}') {
                  depth--;
                  if (depth === 0) {
                    found2 = true;
                    break;
                  }
                }
                k++;
              }
              if (found2) {
                const arg1 = text.substring(i + 6, j);
                const arg2 = text.substring(j + 2, k);
                const normalizedArg1 = this._processText(arg1);
                const normalizedArg2 = this._processText(arg2);
                output.push(`(${normalizedArg1})/(${normalizedArg2})`);
                i = k + 1;
                continue;
              } else {
                break;
              }
            } else {
              if (j + 1 >= n) {
                break;
              }
            }
          }
        }

        // Map common LaTeX commands to clean Unicode symbols
        let matched = false;
        const latexSymbols = [
          ["\\alpha", "α"], ["\\beta", "β"], ["\\gamma", "γ"], ["\\delta", "δ"],
          ["\\epsilon", "ε"], ["\\zeta", "ζ"], ["\\eta", "η"], ["\\theta", "θ"],
          ["\\iota", "ι"], ["\\kappa", "κ"], ["\\lambda", "λ"], ["\\mu", "μ"],
          ["\\nu", "ν"], ["\\xi", "ξ"], ["\\pi", "π"], ["\\rho", "ρ"],
          ["\\sigma", "σ"], ["\\tau", "τ"], ["\\upsilon", "υ"], ["\\phi", "φ"],
          ["\\chi", "χ"], ["\\psi", "ψ"], ["\\omega", "ω"],
          ["\\Delta", "Δ"], ["\\Omega", "Ω"], ["\\Sigma", "Σ"], ["\\Pi", "Π"],
          ["\\Gamma", "Γ"], ["\\Phi", "Φ"], ["\\Psi", "Ψ"], ["\\Xi", "Ξ"],
          ["\\Theta", "Θ"], ["\\Lambda", "Λ"],
          ["\\times", "×"], ["\\div", "÷"], ["\\pm", "±"],
          ["\\leq", "≤"], ["\\geq", "≥"], ["\\le", "≤"], ["\\ge", "≥"],
          ["\\neq", "≠"], ["\\ne", "≠"], ["\\approx", "≈"], ["\\in", "∈"],
          ["\\notin", "∉"], ["\\infty", "∞"], ["\\cdot", "·"],
          ["\\rightarrow", "→"], ["\\leftarrow", "←"], ["\\to", "→"],
          ["\\Rightarrow", "⇒"], ["\\implies", "⇒"], ["\\leftrightarrow", "↔"],
          ["\\Leftrightarrow", "⇔"], ["\\Leftarrow", "⇐"]
        ];

        for (const [lat, uni] of latexSymbols) {
          if (text.startsWith(lat, i)) {
            output.push(uni);
            i += lat.length;
            matched = true;
            break;
          }
        }
        if (matched) continue;
      }

      // 3. Check for text arrows: `->` and `=>`
      if (text.startsWith("->", i)) {
        output.push("→");
        i += 2;
        continue;
      }
      if (text.startsWith("=>", i)) {
        output.push("⇒");
        i += 2;
        continue;
      }

      // 4. Check for html entities
      if (text[i] === '&') {
        let matched = false;
        const htmlEntities = [
          ["&gt;", ">"], ["&lt;", "<"], ["&amp;", "&"], ["&quot;", '"'],
          ["&#39;", "'"], ["&rarr;", "→"], ["&larr;", "←"]
        ];
        for (const [ent, val] of htmlEntities) {
          if (text.startsWith(ent, i)) {
            output.push(val);
            i += ent.length;
            matched = true;
            break;
          }
        }
        if (matched) continue;
      }

      // 5. Check for LaTeX math delimiters ($ and $$) and strip them
      if (text[i] === '$') {
        if (text.startsWith("$$", i)) {
          i += 2;
          continue;
        }
        // Keep $ if it looks like a currency symbol (followed by digit)
        let j = i + 1;
        while (j < n && text[j] === ' ') {
          j++;
        }
        if (j < n && text[j] >= '0' && text[j] <= '9') {
          output.push('$');
          i++;
          continue;
        } else {
          i++;
          continue;
        }
      }

      // Default: copy character
      output.push(text[i]);
      i++;
    }

    return output.join("");
  }
}
