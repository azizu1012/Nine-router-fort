/**
 * Stateful stream parser ported from Python (XMLThinkingExtractor in format_normalizer.py).
 * Extracts `<think>...</think>` and `<thinking>...</thinking>` tags from a text stream,
 * yielding events for text, starting thinking, thinking content, and ending thinking.
 * Properly buffers incomplete tag delimiters split across SSE packets.
 */
export class XMLThinkingExtractor {
  constructor() {
    this.buffer = "";
    this.inThinking = false;
    this.currentTag = null; // "thinking" or "think"
  }

  feed(chunk) {
    if (!chunk) return [];
    this.buffer += chunk;
    const events = [];

    while (true) {
      if (!this.buffer) break;

      if (!this.inThinking) {
        // Find first '<'
        const idx = this.buffer.indexOf('<');
        if (idx === -1) {
          // No '<', everything is regular text
          events.push({ type: "text", content: this.buffer });
          this.buffer = "";
          break;
        } else {
          // Found '<'. Prefix is regular text.
          if (idx > 0) {
            events.push({ type: "text", content: this.buffer.substring(0, idx) });
            this.buffer = this.buffer.substring(idx);
          }

          // Check if buffer starts with a valid open tag
          const openTags = ["<thinking>", "<think>"];
          let matchedTag = null;
          for (const tag of openTags) {
            if (this.buffer.startsWith(tag)) {
              matchedTag = tag;
              break;
            }
          }

          if (matchedTag) {
            this.inThinking = true;
            this.currentTag = matchedTag === "<thinking>" ? "thinking" : "think";
            this.buffer = this.buffer.substring(matchedTag.length);
            events.push({ type: "start_thinking", content: "" });
            continue;
          }

          // Check if buffer is a prefix of any open tag (wait for more data if short)
          let isPrefix = false;
          for (const tag of openTags) {
            if (tag.startsWith(this.buffer)) {
              isPrefix = true;
              break;
            }
          }

          if (isPrefix && this.buffer.length < 11) {
            break; // Wait for next packet chunk
          } else {
            // Not an open tag, treat '<' as regular text
            events.push({ type: "text", content: this.buffer[0] });
            this.buffer = this.buffer.substring(1);
            continue;
          }
        }
      } else {
        // Currently in thinking mode. Find close tag: </thinking> or </think>
        const closeTag = this.currentTag === "thinking" ? "</thinking>" : "</think>";
        const idx = this.buffer.indexOf('</');
        if (idx === -1) {
          // Check if buffer ends with a potential prefix of the close tag
          const bufLen = this.buffer.length;
          let foundPotential = false;
          let potentialIdx = -1;
          for (let i = Math.max(0, bufLen - closeTag.length); i < bufLen; i++) {
            const sub = this.buffer.substring(i);
            if (closeTag.startsWith(sub)) {
              foundPotential = true;
              potentialIdx = i;
              break;
            }
          }

          if (foundPotential) {
            if (potentialIdx > 0) {
              events.push({ type: "thinking", content: this.buffer.substring(0, potentialIdx) });
              this.buffer = this.buffer.substring(potentialIdx);
            }
            break; // Wait for next chunk
          } else {
            events.push({ type: "thinking", content: this.buffer });
            this.buffer = "";
            break;
          }
        } else {
          if (idx > 0) {
            events.push({ type: "thinking", content: this.buffer.substring(0, idx) });
            this.buffer = this.buffer.substring(idx);
          }

          if (this.buffer.startsWith(closeTag)) {
            this.inThinking = false;
            this.currentTag = null;
            this.buffer = this.buffer.substring(closeTag.length);
            events.push({ type: "end_thinking", content: "" });
            continue;
          }

          if (closeTag.startsWith(this.buffer) && this.buffer.length < closeTag.length) {
            break; // Wait
          } else {
            events.push({ type: "thinking", content: this.buffer.substring(0, 2) });
            this.buffer = this.buffer.substring(2);
            continue;
          }
        }
      }
    }

    return events;
  }

  flush() {
    const events = [];
    if (this.buffer) {
      if (this.inThinking) {
        events.push({ type: "thinking", content: this.buffer });
      } else {
        events.push({ type: "text", content: this.buffer });
      }
      this.buffer = "";
    }
    return events;
  }
}
