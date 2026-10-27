// Muse (Meta) model guidance. The wire is Responses-only; `tool_choice` must be
// "auto", so there is no server-side way to force a tool call. Muse 1.3 tends to
// end a turn with an announcement ("I'll now ...") instead of acting on it, which
// stalls long agent runs. This directive asks the model to carry intent out in
// the same turn. Scoped to the direct provider id.
export const MUSE_TOOL_USE_DIRECTIVE = [
  "You are operating as an autonomous agent with tools.",
  "When the task requires an action, call the necessary tool in this same turn.",
  "Never end a turn with only a statement of intent, a plan, or an announcement such as \"I'll now ...\" — execute it immediately.",
  "Only produce a final answer when the work is actually complete.",
].join(" ");

export function isMuseToolDirectiveEnabled() {
  return process.env.MUSE_TOOL_DIRECTIVE !== "0";
}

// Even with the directive, Muse 1.3 sometimes ends a turn with only an
// announcement ("I'll check the repo now.") and no tool call. The router can
// make one bounded continuation: replay the turn's reasoning + assistant text,
// then add a short user nudge that asks the model to act. This is scoped to
// translated (Chat/Claude) clients on the direct provider: native Responses
// clients own their turn loop and would see duplicate item ids.
export const MUSE_CONTINUATION = Object.freeze({
  maxAnnouncementChars: 800,
  // One extra turn is enough to recover the common announce-then-stop case;
  // more would multiply latency and cost when the model is genuinely done.
  maxRetries: 1,
  nudge: [
    "Continue now. You announced the next action but did not perform it.",
    "Call the required tool in this turn.",
    "Do not restate the plan or ask for confirmation unless a tool result requires it.",
  ].join(" "),
});

// English announcement: a first-person future/let-me clause followed by an
// action verb. Requiring the clause keeps ordinary imperative prose out.
export const MUSE_ANNOUNCEMENT_EN = /^(?:(?:next|now|then|first|okay|ok|alright|sure)\b[\s,.:;-]*)?(?:i(?:'ll| will| am going to|'m going to| need to| should| can|'d| would)(?: better)?|let(?:'s| us| me)|we(?:'ll| will| need to))\b[\s,.:;-]*(?:(?:also|then|now|first|just)\s+)*(?:start by |go ahead and |proceed to )?(?:check|verify|confirm|validate|inspect|examine|look (?:at|into)|read|review|open|search|find|locate|trace|investigate|run|test|execute|update|edit|modify|fix|patch|apply|write|create|add|remove|delete|install|build|continue|follow up)\b/iu;

// Vietnamese announcement ("Tôi sẽ kiểm tra...", "Để tôi xem...").
export const MUSE_ANNOUNCEMENT_VI = /^(?:(?:tiếp theo|bây giờ|ok|okay|được|vâng|ừ)[,\s]*)?(?:(?:tôi|mình)\s+(?:sẽ|đang định|cần|phải)|để\s+(?:tôi|mình))\s+(?:kiểm tra|xem|đọc|chạy|thử|tìm|sửa|cập nhật|mở|rà soát|kiểm|theo dõi|điều tra|xác minh|triển khai|áp dụng|viết|tạo)/iu;

// If the text already carries a result, evidence, or a hand-off to the user,
// it is a final answer, not an announcement awaiting action.
export const MUSE_ANNOUNCEMENT_RESULT = /(?:^|[.!?]\s+|\n)\s*(?:here(?:'s| is)|the (?:result|answer|fix|issue|problem)|results?\s*:|found\b|error\s*:|done\b|completed\b|i(?:'ve| have)\b|summary\b|conclusion\b)|```|\b(?:is|are|was|were)\s+(?:now\s+)?(?:fixed|updated|passing|failing|complete|green|healthy|broken)\b|(?:^|[.!?]\s+|\n)\s*(?:kết quả|đã\s|phát hiện|tìm thấy|hoàn thành|xong\b)/iu;

export const MUSE_ANNOUNCEMENT_WAIT = /\b(?:let me know|would you like|do you want|should i|shall i|if you(?:'d| would)? (?:like|want)|please (?:confirm|approve|provide|send)|waiting for (?:you|your)|your (?:approval|confirmation|input|permission))\b|(?:cho tôi biết|bạn có muốn|bạn cần tôi|vui lòng (?:xác nhận|phê duyệt|cung cấp)|chờ bạn|đợi bạn)/iu;

export function isMuseContinuationEnabled() {
  return process.env.MUSE_CONTINUATION !== "0";
}
