/**
 * HTML for the SEP-24 interactive webview (Issue #1015).
 *
 * Pages are server-rendered with no external assets: one inline stylesheet and,
 * on the completion page, one inline script. Both carry the per-response CSP
 * nonce, so the policy can stay `default-src 'none'` with no `unsafe-inline`.
 */

import type {
  CallbackTarget,
  Sep24Operation,
  Sep24Session,
} from "./sep24Interactive";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/**
 * JSON safe to embed inside a <script> element: neutralises `</script>`,
 * HTML comments and the JS line terminators U+2028/U+2029.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14171f;--muted:#5b6474;--line:#d5d9e1;--accent:#2f5bea;--accent-fg:#fff;--err:#b3261e;--ok:#1a7f4b}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#181c25;--fg:#eef0f5;--muted:#9aa3b5;--line:#2c3342;--accent:#7b9bff;--accent-fg:#0f1218;--err:#ff8a80;--ok:#5fd39a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:30rem;margin:0 auto;padding:1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.25rem}
h1{font-size:1.25rem;margin:0 0 .25rem}
p.lead{margin:0 0 1rem;color:var(--muted)}
.summary{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1rem;padding:0;list-style:none}
.summary li{background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:.15rem .7rem;font-size:.85rem}
label{display:block;font-weight:600;margin:.9rem 0 .25rem}
.hint{font-weight:400;color:var(--muted);font-size:.85rem}
input{width:100%;padding:.65rem .75rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:1px}
input[aria-invalid=true]{border-color:var(--err)}
.err{color:var(--err);font-size:.875rem;margin:.25rem 0 0}
.banner{border:1px solid var(--err);color:var(--err);border-radius:8px;padding:.6rem .8rem;margin:0 0 1rem}
button{margin-top:1.25rem;width:100%;padding:.8rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:700;cursor:pointer}
.ok{color:var(--ok)}
fieldset{border:0;padding:0;margin:0}
.fine{margin-top:1rem;color:var(--muted);font-size:.8rem}
`;

function page(title: string, nonce: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style nonce="${escapeHtml(nonce)}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>${script}
</body>
</html>
`;
}

const COPY: Record<
  Sep24Operation,
  { title: string; lead: string; accountLegend: string }
> = {
  withdraw: {
    title: "Withdraw to your bank",
    lead: "Tell us where to send your money.",
    accountLegend: "Payout account",
  },
  deposit: {
    title: "Complete your deposit",
    lead: "We need a few details to process your deposit. They are only used to refund you if it fails.",
    accountLegend: "Refund account",
  },
};

export interface FormValues {
  full_name?: string;
  bank_name?: string;
  account_number?: string;
  email?: string;
  amount?: string;
}

export interface RenderFormOptions {
  nonce: string;
  token: string;
  callback?: string;
  session: Pick<Sep24Session, "operation" | "assetCode" | "amount">;
  values?: FormValues;
  errors?: Record<string, string>;
  bannerError?: string;
  /** Path the form posts to. */
  action?: string;
}

function field(
  id: keyof FormValues,
  label: string,
  opts: {
    value?: string | undefined;
    error?: string | undefined;
    hint?: string;
    type?: string;
    autocomplete: string;
    inputmode?: string;
    required?: boolean;
    maxlength: number;
  },
): string {
  const describedBy = [opts.hint ? `${id}-hint` : "", opts.error ? `${id}-err` : ""]
    .filter(Boolean)
    .join(" ");
  return `<label for="${id}">${escapeHtml(label)}${
    opts.hint ? ` <span class="hint" id="${id}-hint">${escapeHtml(opts.hint)}</span>` : ""
  }</label>
<input id="${id}" name="${id}" type="${opts.type ?? "text"}" value="${escapeHtml(opts.value ?? "")}"
 autocomplete="${opts.autocomplete}"${opts.inputmode ? ` inputmode="${opts.inputmode}"` : ""}
 maxlength="${opts.maxlength}"${opts.required ? " required" : ""}${
   opts.error ? ' aria-invalid="true"' : ""
 }${describedBy ? ` aria-describedby="${describedBy}"` : ""}>${
   opts.error ? `\n<p class="err" id="${id}-err" role="alert">${escapeHtml(opts.error)}</p>` : ""
 }`;
}

export function renderForm(opts: RenderFormOptions): string {
  const { session, values = {}, errors = {} } = opts;
  const copy = COPY[session.operation];
  const amount = values.amount ?? session.amount ?? "";

  const body = `<section class="card" aria-labelledby="title">
<h1 id="title">${escapeHtml(copy.title)}</h1>
<p class="lead">${escapeHtml(copy.lead)}</p>
<ul class="summary" aria-label="Transaction summary">
<li>${escapeHtml(session.operation === "withdraw" ? "Withdrawal" : "Deposit")}</li>
<li>${escapeHtml(session.assetCode)}</li>
</ul>
${
  opts.bannerError
    ? `<p class="banner" role="alert">${escapeHtml(opts.bannerError)}</p>`
    : ""
}
<form method="post" action="${escapeHtml(opts.action ?? "/sep24/interactive")}" novalidate>
<input type="hidden" name="token" value="${escapeHtml(opts.token)}">
<input type="hidden" name="callback" value="${escapeHtml(opts.callback ?? "")}">
<fieldset><legend class="hint">${escapeHtml(copy.accountLegend)}</legend>
${field("full_name", "Account holder name", { value: values.full_name, error: errors.full_name, autocomplete: "name", required: true, maxlength: 100 })}
${field("bank_name", "Bank name", { value: values.bank_name, error: errors.bank_name, autocomplete: "organization", required: true, maxlength: 100 })}
${field("account_number", "Account number", { value: values.account_number, error: errors.account_number, hint: "IBAN or local number", autocomplete: "off", inputmode: "text", required: true, maxlength: 40 })}
</fieldset>
${field("email", "Email", { value: values.email, error: errors.email, hint: "optional", type: "email", autocomplete: "email", maxlength: 254 })}
${field("amount", `Amount (${session.assetCode})`, { value: amount, error: errors.amount, hint: "optional", autocomplete: "off", inputmode: "decimal", maxlength: 24 })}
<button type="submit">Continue</button>
</form>
<p class="fine">Your details are encrypted and shared only with the anchor to complete this transaction.</p>
</section>`;

  return page(copy.title, opts.nonce, body);
}

export function renderMessage(opts: {
  nonce: string;
  title: string;
  message: string;
  tone?: "ok" | "error";
}): string {
  const body = `<section class="card" aria-labelledby="title">
<h1 id="title"${opts.tone === "ok" ? ' class="ok"' : ""}>${escapeHtml(opts.title)}</h1>
<p class="lead">${escapeHtml(opts.message)}</p>
</section>`;
  return page(opts.title, opts.nonce, body);
}

export interface CompletionPayload {
  transaction: { id: string; status: string; more_info_url: string };
  completion_token: string;
}

/**
 * Success page. For `postMessage` callbacks the inline script hands the payload
 * to the opener (popup) or parent (iframe) — but only with an explicit target
 * origin, never `*`.
 */
export function renderComplete(opts: {
  nonce: string;
  payload: CompletionPayload;
  callback: CallbackTarget;
  urlCallbackDelivered?: boolean;
}): string {
  const { callback } = opts;
  let extra = "You can return to your wallet.";
  let script = "";

  if (callback.kind === "postMessage") {
    if (callback.targetOrigin) {
      script = `
<script nonce="${escapeHtml(opts.nonce)}">
(function(){
  var payload=${jsonForScript(opts.payload)};
  var target=${jsonForScript(callback.targetOrigin)};
  var w=window.opener||(window.parent!==window?window.parent:null);
  if(w){w.postMessage(payload,target);}
})();
</script>`;
      extra = "Returning you to your wallet…";
    }
  } else if (callback.kind === "url") {
    extra = opts.urlCallbackDelivered
      ? "Your wallet has been notified."
      : "Return to your wallet to continue.";
  }

  const body = `<section class="card" aria-labelledby="title">
<h1 id="title" class="ok">Details received</h1>
<p class="lead">Thanks — your transaction is now waiting for the next step. ${escapeHtml(extra)}</p>
</section>`;
  return page("Details received", opts.nonce, body, script);
}
