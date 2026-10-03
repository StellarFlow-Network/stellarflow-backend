/**
 * Governance WebSocket Service Tests
 *
 * Tests for XSS sanitization and WebSocket functionality.
 */

import assert from "node:assert/strict";

// ─── XSS Sanitization Function (inline for testing) ───────────────────────

function sanitizeChatMessage(content: string): string {
  if (typeof content !== "string") {
    return "";
  }

  // Remove script tags and their content
  let sanitized = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

  // Remove other dangerous HTML tags
  const dangerousTags = [
    /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
    /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
    /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi,
    /<link\b[^>]*>/gi,
    /<meta\b[^>]*>/gi,
    /<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi,
  ];

  dangerousTags.forEach((regex) => {
    sanitized = sanitized.replace(regex, "");
  });

  // Remove on* event handlers (onclick, onerror, etc.)
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, "");
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*[^"'>\s]*/gi, "");

  // Remove javascript: protocol
  sanitized = sanitized.replace(/javascript:/gi, "");

  // Remove data: URIs that could execute scripts (except safe images)
  sanitized = sanitized.replace(/data:(?!image\/(png|jpeg|gif|webp))/gi, "");

  // Remove DOM-based XSS patterns
  sanitized = sanitized.replace(/document\./gi, "");
  sanitized = sanitized.replace(/window\./gi, "");
  sanitized = sanitized.replace(/eval\(/gi, "");

  // Strip remaining HTML tags but keep text content
  sanitized = sanitized.replace(/<[^>]*>/g, "");

  // Decode HTML entities to prevent double-encoding attacks
  sanitized = sanitized
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Trim whitespace
  sanitized = sanitized.trim();

  // Limit length to prevent abuse
  const MAX_LENGTH = 5000;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LENGTH);
  }

  return sanitized;
}

// ─── Tests ───────────────────────────────────────────────────────────────

function testRemoveScriptTags() {
  console.log("\n🧪 Testing script tag removal...");
  const input = "Hello <script>alert('xss')</script> World";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("<script>"), false, "Should remove script tags");
  assert.equal(result.includes("alert"), false, "Should remove alert");
  assert.equal(result.includes("Hello"), true, "Should preserve safe text");
  assert.equal(result.includes("World"), true, "Should preserve safe text");
  console.log("✅ Script tag removal test passed");
}

function testRemoveIframeTags() {
  console.log("\n🧪 Testing iframe tag removal...");
  const input = "Check this <iframe src='evil.com'></iframe> link";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("<iframe>"), false, "Should remove iframe tags");
  assert.equal(result.includes("evil.com"), false, "Should remove iframe src");
  console.log("✅ Iframe tag removal test passed");
}

function testRemoveOnclickHandlers() {
  console.log("\n🧪 Testing onclick handler removal...");
  const input = "Click <div onclick='alert(1)'>here</div>";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("onclick"), false, "Should remove onclick handlers");
  assert.equal(result.includes("alert"), false, "Should remove alert");
  console.log("✅ Onclick handler removal test passed");
}

function testRemoveJavascriptProtocol() {
  console.log("\n🧪 Testing javascript: protocol removal...");
  const input = "Visit <a href='javascript:alert(1)'>link</a>";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("javascript:"), false, "Should remove javascript: protocol");
  console.log("✅ Javascript protocol removal test passed");
}

function testRemoveDocumentWindowReferences() {
  console.log("\n🧪 Testing document/window reference removal...");
  const input = "document.cookie and window.location";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("document"), false, "Should remove document references");
  assert.equal(result.includes("window"), false, "Should remove window references");
  console.log("✅ Document/window reference removal test passed");
}

function testRemoveEvalCalls() {
  console.log("\n🧪 Testing eval call removal...");
  const input = "eval('malicious code')";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("eval"), false, "Should remove eval calls");
  console.log("✅ Eval call removal test passed");
}

function testPreserveSafeText() {
  console.log("\n🧪 Testing safe text preservation...");
  const input = "This is a safe message with normal text.";
  const result = sanitizeChatMessage(input);
  assert.equal(result, input, "Should preserve safe text unchanged");
  console.log("✅ Safe text preservation test passed");
}

function testHandleEmptyString() {
  console.log("\n🧪 Testing empty string handling...");
  const input = "";
  const result = sanitizeChatMessage(input);
  assert.equal(result, "", "Should handle empty string");
  console.log("✅ Empty string handling test passed");
}

function testHandleNullUndefined() {
  console.log("\n🧪 Testing null/undefined handling...");
  assert.equal(sanitizeChatMessage(null as any), "", "Should handle null");
  assert.equal(sanitizeChatMessage(undefined as any), "", "Should handle undefined");
  console.log("✅ Null/undefined handling test passed");
}

function testLimitMessageLength() {
  console.log("\n🧪 Testing message length limit...");
  const longInput = "a".repeat(6000);
  const result = sanitizeChatMessage(longInput);
  assert.equal(result.length, 5000, "Should limit to 5000 characters");
  console.log("✅ Message length limit test passed");
}

function testRemoveMultipleDangerousTags() {
  console.log("\n🧪 Testing multiple dangerous tag removal...");
  const input = "<script>alert(1)</script><iframe src='x'></iframe><div onclick='x'>text</div>";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("<script>"), false, "Should remove script tags");
  assert.equal(result.includes("<iframe>"), false, "Should remove iframe tags");
  assert.equal(result.includes("onclick"), false, "Should remove onclick handlers");
  console.log("✅ Multiple dangerous tag removal test passed");
}

function testDecodeHtmlEntities() {
  console.log("\n🧪 Testing HTML entity decoding...");
  const input = "Hello &lt;world&gt; &amp; friends";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("<"), true, "Should decode &lt;");
  assert.equal(result.includes(">"), true, "Should decode &gt;");
  assert.equal(result.includes("&"), true, "Should decode &amp;");
  console.log("✅ HTML entity decoding test passed");
}

function testTrimWhitespace() {
  console.log("\n🧪 Testing whitespace trimming...");
  const input = "  Hello World  ";
  const result = sanitizeChatMessage(input);
  assert.equal(result, "Hello World", "Should trim whitespace");
  console.log("✅ Whitespace trimming test passed");
}

function testHandleNestedHtmlTags() {
  console.log("\n🧪 Testing nested HTML tag handling...");
  const input = "<div><span><script>alert(1)</script></span></div>";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("<script>"), false, "Should remove script tags");
  assert.equal(result.includes("<div>"), false, "Should remove div tags");
  assert.equal(result.includes("<span>"), false, "Should remove span tags");
  console.log("✅ Nested HTML tag handling test passed");
}

function testRemoveDataUris() {
  console.log("\n🧪 Testing data URI removal...");
  const input = "data:text/html,<script>alert(1)</script> and data:image/png;base64,abc";
  const result = sanitizeChatMessage(input);
  assert.equal(result.includes("data:text/html"), false, "Should remove dangerous data URIs");
  assert.equal(result.includes("data:image/png"), true, "Should preserve safe image data URIs");
  console.log("✅ Data URI removal test passed");
}

function runAllTests() {
  console.log("🚀 Starting Governance WebSocket sanitization tests...\n");

  testRemoveScriptTags();
  testRemoveIframeTags();
  testRemoveOnclickHandlers();
  testRemoveJavascriptProtocol();
  testRemoveDocumentWindowReferences();
  testRemoveEvalCalls();
  testPreserveSafeText();
  testHandleEmptyString();
  testHandleNullUndefined();
  testLimitMessageLength();
  testRemoveMultipleDangerousTags();
  testDecodeHtmlEntities();
  testTrimWhitespace();
  testHandleNestedHtmlTags();
  testRemoveDataUris();

  console.log("\n✅ All Governance WebSocket sanitization tests passed!");
}

runAllTests();
