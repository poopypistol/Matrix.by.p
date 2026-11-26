/* Slack approval cards: what happens when someone taps a button on a declan card in Slack.
   Slack posts every tap here. Each tap is checked against Slack's signing secret, matched to a declan
   person by their Slack email, and then does exactly what the same button does in declan.
   Deploy with JWT verification OFF (Slack can't send a Supabase login). Needs the secrets
   SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET. */
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const url = Deno.env.get("SUPABASE_URL")!;
const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  (secretKeys ? JSON.parse(secretKeys).default : "");
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const slackToken = Deno.env.get("SLACK_BOT_TOKEN") || "";
const signingSecret = Deno.env.get("SLACK_SIGNING_SECRET") || "";
const SITE = "https://declanbyp.vercel.app";

/* ---------- Slack plumbing ---------- */
async function verified(request: Request, raw: string) {
  const stamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";
  if (!signingSecret || !stamp || Math.abs(Date.now() / 1000 - Number(stamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("v0:" + stamp + ":" + raw));
  const expected = "v0=" + [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
async function slack(method: string, body: object) {
  const response = await fetch("https://slack.com/api/" + method, {
    method: "POST",
    headers: { Authorization: "Bearer " + slackToken, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) console.error("Slack " + method + " failed", result.error, JSON.stringify(result.response_metadata || {}));
  return result;
}
async function emailOf(userId: string) {
  const response = await fetch("https://slack.com/api/users.info?user=" + encodeURIComponent(userId), { headers: { Authorization: "Bearer " + slackToken } });
  const result = await response.json();
  return result.ok ? String(result.user?.profile?.email || "").toLowerCase() : "";
}
const reply = (responseUrl: string, body: object) =>
  fetch(responseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const whisper = (responseUrl: string, text: string) => reply(responseUrl, { response_type: "ephemeral", replace_original: false, text });
const escapeSlack = (text: string) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------- declan rules, the same as the site ---------- */
function nameOf(members: any[], email: string) {
  if (!email) return "Someone";
  const person = members.find((item) => item.email === email);
  const saved = person && (person.roles || []).find((role: any) => typeof role === "string" && role.startsWith("name:"));
  if (saved) return saved.slice(5);
  const name = String(email).split("@")[0].split("+")[0].replace(/[._-]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}
const firstName = (members: any[], email: string) => {
  const full = nameOf(members, email);
  const tag = full.match(/\(([^)]+)\)/);
  const first = full.split(/\s+/)[0];
  const clash = members.some((person) => person.email !== email && person.role !== "client" && nameOf(members, person.email).split(/\s+/)[0] === first);
  return clash ? (tag ? tag[1] : full) : first;
};
const adminOf = (members: any[]) => (members.find((item) => item.role === "admin") || {}).email || "";
const finalOf = (members: any[]) => (members.find((item) => item.role !== "client" && (item.roles || []).includes("final")) || {}).email || "";
const creatorOf = (post: any, members: any[]) => post.created_by || adminOf(members);
const options = (post: any) => (Array.isArray(post.copy_options) && post.copy_options.length > 1 ? post.copy_options : []);
function pickOf(post: any) {
  const entry = [...(post.history || [])].reverse().find((item: any) => item.type === "picked");
  const option = entry ? entry.option : 0;
  return option >= 1 && option <= options(post).length ? option : 0;
}
/* The same followers the site tells: whoever made it, whoever has it, managers who approved it on the way. */
function followers(post: any, members: any[], actor: string) {
  const final = finalOf(members);
  const approvers = (post.history || []).filter((entry: any) => entry.type === "approved_manager").map((entry: any) => entry.by);
  const keepFinal = creatorOf(post, members) === final || (post.stage || "draft") === "internal";
  return [creatorOf(post, members), post.manager, ...approvers]
    .filter((email) => keepFinal || email !== final)
    .filter((email, index, all) => email && email !== actor && all.indexOf(email) === index);
}
/* A fingerprint of what the card showed, so a tap never approves content that changed after the card was sent. */
function fingerprint(post: any) {
  const text = JSON.stringify([post.copy_text || "", post.copy_options || null, post.tags || "", post.link || "", (post.cover_file || {}).id || "", post.stage || "", post.manager || "", post.post_date || ""]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
const STEP_TYPES = ["sent", "changes", "approved_manager", "approved_internal", "back"];
/* What the caption said before this round of edits, so the next person sees every change since it was written. */
function originalCaption(post: any, base: string) {
  const step = [...(post.history || [])].reverse().find((entry: any) => STEP_TYPES.includes(entry.type));
  return step && step.before && "copy" in step.before ? step.before.copy : base;
}
const STATUS: Record<string, string> = { draft: "in Drafting", ready: "ready to send to the client", client: "with the client", approved: "approved" };

/* ---------- the card after someone acts ---------- */
function doneCard(post: any, members: any[], text: string) {
  const client = post.client_name ? " · " + escapeSlack(post.client_name) : "";
  return [
    { type: "section", text: { type: "mrkdwn", text: "✓ " + text + "\n*" + escapeSlack(post.title || "Untitled post") + "*" + client } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in declan" }, url: SITE + "/#post-" + post.id, action_id: "open" }] },
  ];
}
async function settleCard(channel: string, ts: string, post: any, members: any[], text: string) {
  if (!channel || !ts) return;
  await slack("chat.update", { channel, ts, text, blocks: doneCard(post, members, text) });
}
/* Someone tapped a card that's out of date: say where the post is now. */
function staleText(post: any, members: any[], email: string) {
  const stage = post.stage || "draft";
  if (stage === "internal") return "Already handled. It's with " + (post.manager === email ? "you" : nameOf(members, post.manager)) + " now.";
  return "Already handled. It's " + (STATUS[stage] || "moved on") + " now.";
}

/* ---------- the two outcomes ---------- */
async function approve(post: any, members: any[], email: string, pick: number, caption: string | null, note: string) {
  const now = Date.now();
  const final = finalOf(members);
  const creator = creatorOf(post, members);
  const onward = final && final !== email && final !== creator;
  const history = [...(post.history || [])];
  const change: Record<string, any> = {};
  let base = post.copy_text || "";
  if (options(post).length) {
    if (pick !== pickOf(post)) history.push({ type: "picked", by: email, at: now, option: pick, to: [] });
    base = options(post)[pick - 1];
    change.copy_text = base;
  }
  const edited = caption !== null && caption.trim() !== base.trim();
  if (edited) change.copy_text = caption;
  const extra = edited ? { fields: ["caption"], before: { copy: originalCaption(post, base) } } : {};
  const after = { ...post, manager: onward ? final : post.manager };
  const entry = onward
    ? { type: "approved_manager", ...extra, ...(note ? { note } : {}), to: [final, ...followers(after, members, email)].filter((v, i, a) => a.indexOf(v) === i), by: email, at: now + 1 }
    : { type: "approved_internal", ...extra, ...(note ? { note } : {}), to: [creator, ...followers(after, members, email)].filter((v, i, a) => v !== email && a.indexOf(v) === i), by: email, at: now + 1 };
  history.push(entry);
  const update = { ...change, stage: onward ? "internal" : "ready", ...(onward ? { manager: final } : {}), history };
  const { error } = await db.from("posts").update(update).eq("id", post.id).eq("stage", "internal").eq("manager", email);
  if (error) throw error;
  const tail = edited ? " with your edit" : "";
  return onward ? "You approved it" + tail + ". Sent to " + firstName(members, final) + "." : "You approved it" + tail + ". It's ready to send to the client.";
}
async function sendBack(post: any, members: any[], email: string, pick: number, caption: string | null, note: string) {
  const now = Date.now();
  const creator = creatorOf(post, members);
  const history = [...(post.history || [])];
  const change: Record<string, any> = {};
  let base = post.copy_text || "";
  if (options(post).length && pick) {
    if (pick !== pickOf(post)) history.push({ type: "picked", by: email, at: now, option: pick, to: [] });
    base = options(post)[pick - 1];
    change.copy_text = base;
  }
  const edited = caption !== null && caption.trim() !== base.trim();
  if (edited) change.copy_text = caption;
  history.push({
    type: "changes", note, ...(edited ? { fields: ["caption"], before: { copy: originalCaption(post, base) } } : {}),
    to: [creator, ...followers(post, members, email)].filter((v, i, a) => v !== email && a.indexOf(v) === i), by: email, at: now + 1,
  });
  const { error } = await db.from("posts").update({ ...change, stage: "draft", history }).eq("id", post.id).eq("stage", "internal").eq("manager", email);
  if (error) throw error;
  return "Sent back to " + firstName(members, creator) + (edited ? " with your edit" : "") + ".";
}

/* ---------- the edit / send-back box ---------- */
/* The most a Slack text box can hold. Longer captions are edited in declan instead. */
const SLACK_MAX = 3000;
function reviewBox(post: any, members: any[], meta: object, mode: "edit" | "back", caption: string) {
  const final = finalOf(members);
  const creator = creatorOf(post, members);
  const onward = final && final !== (meta as any).email && final !== creator;
  const approveLabel = onward ? "Approve & send to " + firstName(members, final) : "Approve";
  const backLabel = "Send back to " + firstName(members, creator);
  const blocks: any[] = [
    { type: "input", block_id: "caption", label: { type: "plain_text", text: "Caption" },
      element: { type: "plain_text_input", action_id: "v", multiline: true, initial_value: caption, max_length: SLACK_MAX } },
    { type: "input", block_id: "note", optional: mode === "edit", label: { type: "plain_text", text: "Note for " + firstName(members, mode === "back" ? creator : onward ? final : creator) },
      element: { type: "plain_text_input", action_id: "v", multiline: true, placeholder: { type: "plain_text", text: mode === "back" ? "What should change? (optional if you edited the caption)" : "Optional" } } },
  ];
  if (mode === "edit") {
    blocks.push({ type: "input", block_id: "then", label: { type: "plain_text", text: "Then" },
      element: { type: "radio_buttons", action_id: "v",
        initial_option: { text: { type: "plain_text", text: approveLabel }, value: "approve" },
        options: [{ text: { type: "plain_text", text: approveLabel }, value: "approve" }, { text: { type: "plain_text", text: backLabel }, value: "back" }] } });
  }
  if (mode === "back") blocks[1].optional = true;
  return {
    type: "modal", callback_id: "review", private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: mode === "edit" ? "Edit caption" : "Send back" },
    submit: { type: "plain_text", text: mode === "edit" ? "Done" : "Send back" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

/* ---------- loading ---------- */
async function load(postId: string) {
  const [{ data: post }, { data: members }] = await Promise.all([
    db.from("posts").select("*").eq("id", postId).maybeSingle(),
    db.from("members").select("*"),
  ]);
  if (post) {
    const { data: client } = await db.from("clients").select("name").eq("id", post.client_id).maybeSingle();
    post.client_name = client ? client.name : "";
  }
  return { post, members: members || [] };
}
const isMember = (members: any[], email: string) => members.some((item) => item.email === email && item.role !== "client");
/* Choosing an option only changes the card: the choice is marked, and the buttons carry it. It's saved when they approve or send back, like in declan. */
function withChoice(blocks: any[], option: number) {
  return blocks.map((block: any) => {
    if (block.type === "section" && block.accessory && block.accessory.action_id === "choose") {
      const mine = JSON.parse(block.accessory.value || "{}").option === option;
      const title = "*Option " + block.block_id.replace("option-", "") + (mine ? "  ·  ✓ Chosen" : "") + "*";
      const text = block.text.text.replace(/^\*Option \d+(?:  ·  ✓ Chosen)?\*/, title);
      const accessory = { ...block.accessory, text: { type: "plain_text", text: mine ? "✓ Chosen" : "Choose" } };
      if (mine) accessory.style = "primary"; else delete accessory.style;
      return { ...block, text: { ...block.text, text }, accessory };
    }
    if (block.type === "actions" && block.block_id === "decide") {
      return { ...block, elements: block.elements.map((element: any) => {
        if (!element.value) return element;
        const value = JSON.parse(element.value);
        return { ...element, value: JSON.stringify({ ...value, pick: option }) };
      }) };
    }
    return block;
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("ok");
  const raw = await request.text();
  if (!(await verified(request, raw))) return new Response("Not allowed", { status: 401 });
  const payload = JSON.parse(new URLSearchParams(raw).get("payload") || "{}");
  const email = await emailOf(payload.user?.id || "");

  /* A tap on a card */
  if (payload.type === "block_actions") {
    const action = (payload.actions || [])[0] || {};
    if (action.action_id === "open") return new Response("");
    let value: any = {};
    try { value = JSON.parse(action.value || "{}"); } catch { /* not ours */ }
    const { post, members } = await load(value.post || "");
    const channel = payload.container?.channel_id || payload.channel?.id || "";
    const ts = payload.container?.message_ts || payload.message?.ts || "";
    if (!post || (post.history || []).some((entry: any) => entry.type === "deleted")) {
      await reply(payload.response_url, { replace_original: true, text: "This post was deleted." });
      return new Response("");
    }
    if (!isMember(members, email)) { await whisper(payload.response_url, "declan doesn't know your Slack email. Ask Sonsoles to check it matches your declan login."); return new Response(""); }
    if ((post.stage || "draft") !== "internal" || post.manager !== email) {
      await reply(payload.response_url, { replace_original: true, text: staleText(post, members, email), blocks: doneCard(post, members, staleText(post, members, email)) });
      return new Response("");
    }
    if (value.fp !== fingerprint(post)) {
      await whisper(payload.response_url, "This post changed after this message was sent. Open it in declan to see the latest: " + SITE + "/#post-" + post.id);
      return new Response("");
    }
    if (action.action_id === "choose") {
      const blocks = withChoice(payload.message?.blocks || [], Number(value.option) || 0);
      await reply(payload.response_url, { replace_original: true, text: payload.message?.text || "Ready for your review", blocks });
      return new Response("");
    }
    const pick = Number(value.pick) || pickOf(post);
    if (options(post).length && !pick && action.action_id !== "back") {
      await whisper(payload.response_url, "Pick one of the caption options first.");
      return new Response("");
    }
    try {
      if (action.action_id === "approve") {
        const text = await approve(post, members, email, pick, null, "");
        await reply(payload.response_url, { replace_original: true, text, blocks: doneCard(post, members, text) });
      } else if (action.action_id === "back" || action.action_id === "edit") {
        const caption = options(post).length && pick ? options(post)[pick - 1] : post.copy_text || "";
        const meta = { post: post.id, fp: value.fp, pick, channel, ts, email, mode: action.action_id };
        const link = SITE + "/#post-" + post.id;
        if (caption.length > SLACK_MAX) {
          await whisper(payload.response_url, "This caption is " + caption.length.toLocaleString("en-US") + " characters, longer than Slack can edit (" + SLACK_MAX.toLocaleString("en-US") + "). Open it in declan to " + (action.action_id === "edit" ? "edit it" : "send it back") + ": " + link);
          return new Response("");
        }
        const opened = await slack("views.open", { trigger_id: payload.trigger_id, view: reviewBox(post, members, meta, action.action_id === "edit" ? "edit" : "back", caption) });
        if (!opened.ok) await whisper(payload.response_url, "Slack couldn't open the box. Open the post in declan instead: " + link);
      }
    } catch (problem) {
      console.error("Slack action failed", problem);
      await whisper(payload.response_url, "That didn't go through. Try again, or open it in declan.");
    }
    return new Response("");
  }

  /* The edit / send-back box was submitted */
  if (payload.type === "view_submission" && payload.view?.callback_id === "review") {
    const meta = JSON.parse(payload.view.private_metadata || "{}");
    const values = payload.view.state?.values || {};
    const caption = String(values.caption?.v?.value || "");
    const note = String(values.note?.v?.value || "").trim();
    const then = meta.mode === "edit" ? values.then?.v?.selected_option?.value || "approve" : "back";
    const { post, members } = await load(meta.post);
    if (!post || (post.stage || "draft") !== "internal" || post.manager !== email || !isMember(members, email)) {
      if (post) await settleCard(meta.channel, meta.ts, post, members, staleText(post, members, email));
      return Response.json({ response_action: "clear" });
    }
    if (meta.fp !== fingerprint(post)) {
      return Response.json({ response_action: "errors", errors: { caption: "This post changed after the message was sent. Cancel and open it in declan." } });
    }
    const base = options(post).length && meta.pick ? options(post)[meta.pick - 1] : post.copy_text || "";
    if (!caption.trim()) return Response.json({ response_action: "errors", errors: { caption: "The caption can't be empty." } });
    if (then === "back" && !note && caption.trim() === base.trim()) {
      return Response.json({ response_action: "errors", errors: { note: "Add a note, or edit the caption, so they know what to change." } });
    }
    try {
      const text = then === "approve"
        ? await approve(post, members, email, meta.pick, caption, note)
        : await sendBack(post, members, email, meta.pick, caption, note);
      await settleCard(meta.channel, meta.ts, post, members, text);
    } catch (problem) {
      console.error("Slack submit failed", problem);
      return Response.json({ response_action: "errors", errors: { caption: "That didn't go through. Try again, or open it in declan." } });
    }
    return Response.json({ response_action: "clear" });
  }
  return new Response("");
});
