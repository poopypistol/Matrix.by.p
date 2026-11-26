import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import webpush from "npm:web-push@3.6.7";

const url = Deno.env.get("SUPABASE_URL")!;
const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  (secretKeys ? JSON.parse(secretKeys).default : "");
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const SITE = "https://declanbyp.vercel.app";
const slackToken = Deno.env.get("SLACK_BOT_TOKEN");
const slackIds: Record<string, string> = {};
/* Bumps only land on weekdays. A weekend post counts back from the Friday before it, since nobody
   is around to act on Saturday or Sunday, and each "day before" is a workday (Mon to Fri). */
function bumpDay(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const step = () => date.setUTCDate(date.getUTCDate() - 1);
  const weekend = () => date.getUTCDay() === 0 || date.getUTCDay() === 6;
  while (weekend()) step();
  for (let left = days; left > 0;) { step(); if (!weekend()) left--; }
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

const DEFAULT_SCHEDULE = [
  { days: 3, time: "10:00" }, { days: 2, time: "10:00" },
  { days: 1, time: "10:00" }, { days: 1, time: "15:00" },
];
const WINDOW = 10 * 60 * 1000;
// Changes are sent once the person making them has paused this long, so a burst becomes one message.
const QUIET = 2 * 60 * 1000;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function escapeSlack(text: string) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function slackUser(email: string) {
  if (slackIds[email]) return slackIds[email];
  const response = await fetch("https://slack.com/api/users.lookupByEmail?email=" + encodeURIComponent(email), {
    headers: { Authorization: "Bearer " + slackToken },
  });
  const result = await response.json();
  if (!result.ok) {
    console.error("Slack lookup failed", email, result.error);
    return "";
  }
  slackIds[email] = result.user.id;
  return result.user.id;
}

async function sendSlack(email: string, title: string, lines: string[], link: string) {
  if (!slackToken) return false;
  const channel = await slackUser(email);
  if (!channel) return false;
  const text = "*" + title + "*\n" + lines.map(escapeSlack).join("\n") + "\n<" + link + "|Open in declan>";
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: "Bearer " + slackToken, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const result = await response.json();
  if (!result.ok) console.error("Slack message failed", email, result.error);
  return Boolean(result.ok);
}

/* ---------- Approval cards ----------
   When a post is waiting on someone's approval, their Slack message is a card: a simplified post
   with buttons that do what declan's buttons do. Taps go to the slack-actions function. */
function nameOf(members: any[], email: string) {
  if (!email) return "Someone";
  const person = members.find((item) => item.email === email);
  const saved = person && (person.roles || []).find((role: any) => typeof role === "string" && role.startsWith("name:"));
  if (saved) return saved.slice(5);
  return displayName(email);
}
function firstName(members: any[], email: string) {
  const full = nameOf(members, email);
  const tag = full.match(/\(([^)]+)\)/);
  const first = full.split(/\s+/)[0];
  const clash = members.some((person) => person.email !== email && person.role !== "client" && nameOf(members, person.email).split(/\s+/)[0] === first);
  return clash ? (tag ? tag[1] : full) : first;
}
/* Must match slack-actions: a tap only goes through if the post still matches what the card showed. */
function fingerprint(post: any) {
  const text = JSON.stringify([post.copy_text || "", post.copy_options || null, post.tags || "", post.link || "", (post.cover_file || {}).id || "", post.stage || "", post.manager || "", post.post_date || ""]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
const PLATFORM_NAMES: Record<string, string> = { ig: "Instagram", tt: "TikTok", tiktok: "TikTok", instagram: "Instagram" };
async function coverLink(post: any) {
  const files = [post.cover_file, ...(Array.isArray(post.asset_file) ? post.asset_file : post.asset_file ? [post.asset_file] : [])];
  const image = files.find((file: any) => file && file.id && String(file.type || "").startsWith("image/"));
  if (!image) return "";
  // A week is longer than any review should take; after that the card simply shows no picture.
  const { data } = await db.storage.from("assets").createSignedUrl(image.id, 7 * 86400);
  return data ? data.signedUrl : "";
}
function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
/* Long captions are cut at a word, with a link to read the whole thing in declan. */
const PREVIEW = 600;
function captionPreview(text: string, link: string) {
  const full = String(text || "");
  if (full.length <= PREVIEW) return escapeSlack(full);
  const cut = full.slice(0, PREVIEW).replace(/\s+\S*$/, "");
  return escapeSlack(cut) + "…\n<" + link + "|See the full caption in declan>";
}
async function cardBlocks(post: any, members: any[], email: string, clientName: string, title: string, detail: string, finalEmail: string, adminEmail: string) {
  const creator = post.created_by || adminEmail;
  const isFinal = email === finalEmail;
  const onward = finalEmail && !isFinal && finalEmail !== creator;
  // Names line, like the top of a post: done names struck through, you in bold.
  const approvers = (post.history || []).filter((entry: any) => entry.type === "approved_manager").map((entry: any) => entry.by)
    .filter((who: string, i: number, all: string[]) => who !== creator && who !== email && all.indexOf(who) === i);
  const names = ["~" + nameOf(members, creator) + "~", ...approvers.map((who: string) => "~" + nameOf(members, who) + "~"), "*● You*",
    ...(onward ? [nameOf(members, finalEmail)] : []), "Client"].join("  →  ");
  const platforms = (post.platforms || []).map((key: string) => PLATFORM_NAMES[key] || key).join(" + ");
  const when = post.post_date ? whenText(post.post_date, post.post_time || "") : "No date";
  const head: any = { type: "section", text: { type: "mrkdwn", text: "*" + escapeSlack(post.title || "Untitled post") + "*  ·  " + escapeSlack(clientName) + "\n" + escapeSlack([when, platforms].filter(Boolean).join("  ·  ")) } };
  const image = await coverLink(post);
  if (image) head.accessory = { type: "image", image_url: image, alt_text: "Cover" };
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: "*" + escapeSlack(title) + "*\n" + names } },
    head,
  ];
  // Only what the names line doesn't already say: the latest note, and edits made by the last reviewer.
  const step = [...(post.history || [])].reverse().find((entry: any) => ["sent", "approved_manager", "changes", "back", "bump"].includes(entry.type));
  const lines: string[] = [];
  if (step && step.fields && step.fields.length) lines.push(escapeSlack(nameOf(members, step.by) + " edited the " + listText(step.fields)));
  if (step && step.note) lines.push(escapeSlack(nameOf(members, step.by) + ": “" + clip(String(step.note), 1500) + "”"));
  if (title === "BUMP" && post.post_date) lines.push(escapeSlack("Posting " + whenText(post.post_date, post.post_time || "")));
  if (lines.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: lines.join("\n") }] });
  const offered = Array.isArray(post.copy_options) && post.copy_options.length > 1 ? post.copy_options : [];
  const picked = (() => {
    const entry = [...(post.history || [])].reverse().find((item: any) => item.type === "picked");
    return entry && entry.option >= 1 && entry.option <= offered.length ? entry.option : 0;
  })();
  const postLink = SITE + "/#post-" + post.id + (offered.length ? "~options" : "");
  const fp = fingerprint(post);
  if (offered.length) {
    // One list: each option with its own Choose button. The chosen one says so, like declan's highlight.
    offered.forEach((text: string, index: number) => {
      const chosen = picked === index + 1;
      blocks.push({
        type: "section", block_id: "option-" + (index + 1),
        text: { type: "mrkdwn", text: "*Option " + (index + 1) + (chosen ? "  ·  ✓ Chosen" : "") + "*\n" + captionPreview(text, postLink) },
        accessory: { type: "button", action_id: "choose", value: JSON.stringify({ post: post.id, fp, option: index + 1 }),
          text: { type: "plain_text", text: chosen ? "✓ Chosen" : "Choose" }, ...(chosen ? { style: "primary" } : {}) },
      });
    });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Caption*\n" + (post.copy_text ? captionPreview(post.copy_text, postLink) : "No caption yet") } });
  }
  const extras = [post.tags ? "Tags: " + post.tags : "", post.link && post.link !== "n/a" ? "Link: " + post.link : ""].filter(Boolean);
  if (extras.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeSlack(extras.join("   ·   ")) }] });
  const value = JSON.stringify({ post: post.id, fp, pick: picked });
  blocks.push({ type: "actions", block_id: "decide", elements: [
    { type: "button", style: "primary", action_id: "approve", value, text: { type: "plain_text", text: clip(onward ? "Approve & send to " + firstName(members, finalEmail) : "Approve", 75) } },
    { type: "button", action_id: "back", value, text: { type: "plain_text", text: clip("Send back to " + firstName(members, creator), 75) } },
    { type: "button", action_id: "edit", value, text: { type: "plain_text", text: "Edit caption" } },
    { type: "button", action_id: "open", url: SITE + "/#post-" + post.id + "~actions", text: { type: "plain_text", text: "Open in declan" } },
  ] });
  return blocks;
}
async function sendCard(email: string, title: string, blocks: any[], fallback: string) {
  if (!slackToken) return false;
  const channel = await slackUser(email);
  if (!channel) return false;
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: "Bearer " + slackToken, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text: title + ": " + fallback, blocks, unfurl_links: false }),
  });
  const result = await response.json();
  if (!result.ok) console.error("Slack card failed", email, result.error);
  return Boolean(result.ok);
}

function pacificTime(year: number, month: number, day: number, hour: number, minute: number) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour));
  const parts: Record<string, number> = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric",
  }).formatToParts(guess).forEach((part) => { parts[part.type] = Number(part.value); });
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour) - guess.getTime();
  return new Date(guess.getTime() - offset + minute * 60000);
}

const STAGE_NAMES: Record<string, string> = {
  draft: "Drafting", internal: "In review", ready: "Ready to send", client: "Sent to client", approved: "Approved",
};

function stageOf(post: any) {
  return post.stage || "draft";
}

function displayName(email: string) {
  if (!email) return "Someone";
  const name = String(email).split("@")[0].replace(/[._-]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Who a post is waiting on, the same way the site works it out.
function waitingOn(post: any, adminEmail: string, finalEmail = "") {
  const stage = stageOf(post);
  if (stage === "approved") return [];
  if (stage === "internal") return post.manager ? [post.manager] : [];
  const creator = post.created_by || adminEmail;
  if (stage === "draft") return creator ? [creator] : [];
  // Sending to the client and marking it approved is shared: whoever made it or approved it can do it. Not the final approver.
  const approvers = (post.history || [])
    .filter((entry: any) => entry.type === "approved_manager" || entry.type === "approved_internal")
    .map((entry: any) => entry.by)
    .filter((email: string) => email && email !== finalEmail);
  return [creator, ...approvers].filter((email: string, index: number, all: string[]) => email && all.indexOf(email) === index);
}

function timeText(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return (hour % 12 || 12) + (minute ? ":" + String(minute).padStart(2, "0") : "") + (hour < 12 ? "am" : "pm");
}
function whenText(date: string, time: string) {
  return shortDate(date) + (time ? " at " + timeText(time) : "");
}
function listText(items: string[]) {
  return items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

function historyMessage(entry: any, post: any, email: string) {
  const who = displayName(entry.by);
  const note = entry.note ? "\n\"" + entry.note + "\"" : "";
  const reviewer = (entry.to || [])[0];
  switch (entry.type) {
    case "sent":
      if (reviewer === email) return { title: "Ready for your review", detail: who + " sent this for review" + note };
      return { title: entry.passed ? "Reviewer changed" : "Sent for review", detail: who + (entry.passed ? " passed it to " : " sent it to ") + displayName(reviewer) + " for review" };
    case "client": return { title: "Sent to client", detail: who + " marked it sent to the client" };
    case "approved_manager":
      if (reviewer === email) return { title: "Ready for your final approval", detail: who + " approved it" + (entry.fields && entry.fields.length ? " with edits to the " + listText(entry.fields) : "") + ". It needs your OK." + note };
      return { title: "Approved by " + who, detail: "Now with " + displayName(reviewer) + " for final approval" };
    case "moved": return { title: "Date changed", detail: who + " moved it to " + whenText(entry.date, entry.time) + " (was " + whenText(entry.oldDate, entry.oldTime) + ")" };
    case "edited": return { title: entry.stage === "approved" ? "Edited after approval" : "Edited while with the client", detail: who + " changed the " + listText(entry.fields || []) };
    case "deleted": return { title: "Post deleted", detail: who + " deleted it" };
    case "auto": return { title: "Moved back to Drafting", detail: "Info went missing after " + who + "'s edit" };
    case "approved_internal": return { title: "Approved internally", detail: (entry.onBehalf ? who + " marked it approved by " + displayName(entry.onBehalf) : who + " approved it") + ". Ready to send to client." };
    case "changes": return entry.fields && entry.fields.length
      ? { title: "Sent back with edits", detail: who + " edited the " + listText(entry.fields) + " and sent it back to Drafting" + note }
      : { title: "Changes requested", detail: who + " sent this back to Drafting" + note };
    case "approved": return { title: "Approved", detail: who + " marked it client approved. It's green lit." };
    case "back": return { title: "Moved back to " + (STAGE_NAMES[entry.stage] || "an earlier stage"), detail: who + " moved it back" + note };
    case "bump": return { title: "Bump from " + who, detail: "Waiting on " + STAGE_NAMES[stageOf(post)] + note };
    default: return null;
  }
}

function shortDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

async function keys() {
  const { data } = await db.from("push_keys").select("*").eq("id", 1).single();
  if (data.public_key) return data;
  const made = webpush.generateVAPIDKeys();
  await db.from("push_keys").update({ public_key: made.publicKey, private_key: made.privateKey }).eq("id", 1);
  return { ...data, public_key: made.publicKey, private_key: made.privateKey };
}

async function send(subscriptions: any[], email: string, payload: object) {
  let delivered = 0;
  for (const row of subscriptions.filter((item) => item.email === email)) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload));
      delivered++;
    } catch (problem: any) {
      if (problem.statusCode === 404 || problem.statusCode === 410) {
        await db.from("push_subscriptions").delete().eq("endpoint", row.endpoint);
      } else {
        console.error("Push failed", problem.statusCode, problem.body || problem.message);
      }
    }
  }
  return delivered;
}

async function once(key: string) {
  const { error } = await db.from("sent_notifications").insert({ key });
  return !error;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  const config = await keys();
  webpush.setVapidDetails("mailto:sonsoles@digitalmediaarchitects.com", config.public_key, config.private_key);
  const { data: subscriptions } = await db.from("push_subscriptions").select("*");
  const all = subscriptions || [];

  const body = await request.json().catch(() => ({}));
  if (body.test) {
    const token = (request.headers.get("authorization") || "").replace("Bearer ", "");
    const { data } = await db.auth.getUser(token);
    const email = data.user?.email?.toLowerCase();
    if (!email) return new Response("Not signed in", { status: 401, headers: cors });
    if (body.test === "slack") {
      const slack = await sendSlack(email, "BUMP", ["Test notification from declan"], SITE);
      return Response.json({ slack }, { headers: cors });
    }
    const delivered = await send(all, email, { title: "BUMP", body: "Test notification from declan", url: "/" });
    return Response.json({ delivered }, { headers: cors });
  }

  if (request.headers.get("x-cron-secret") !== config.cron_secret) {
    return new Response("Not allowed", { status: 401 });
  }

  const now = Date.now();
  const [{ data: members }, { data: clients }, { data: posts }, { data: notes }, { data: preferences }] =
    await Promise.all([
      db.from("members").select("*"), db.from("clients").select("id, name"),
      db.from("posts").select("*"), db.from("post_comments").select("*"), db.from("preferences").select("*"),
    ]);
  const adminEmail = ((members || []).find((item) => item.role === "admin") || {}).email || "";
  const finalEmail = ((members || []).find((item) => item.role !== "client" && (item.roles || []).includes("final")) || {}).email || "";
  const clientName = Object.fromEntries((clients || []).map((client) => [client.id, client.name]));
  const prefs = Object.fromEntries((preferences || []).map((row) => [row.email, row.data || {}]));
  const notesByPost = Object.fromEntries((notes || []).map((row) => [row.post_id, row.comments || []]));
  let sent = 0;

  // Links open the post at the part the message is about: comments, the action buttons, or caption options.
  const notify = async (email: string, wantsSlack: boolean, post: any, title: string, detail: string, spot = "") => {
    const name = post.title + " · " + (clientName[post.client_id] || "");
    const path = "/#post-" + post.id + (spot ? "~" + spot : "");
    sent += await send(all, email, { title, body: name, url: path });
    if (!wantsSlack) return;
    // Waiting on their approval: the message is a card they can approve from.
    if (stageOf(post) === "internal" && post.manager === email) {
      try {
        const blocks = await cardBlocks(post, members || [], email, clientName[post.client_id] || "", title, detail, finalEmail, adminEmail);
        if (await sendCard(email, title, blocks, name)) { sent++; return; }
      } catch (problem) {
        console.error("Card failed, sending plain message", problem);
      }
    }
    if (await sendSlack(email, title, [name, ...String(detail).split("\n")], SITE + path)) sent++;
  };
  const spotFor = (types: string[], post: any) => {
    if (types.some((type) => type === "changes" || type === "comment")) return "comments";
    if (types.some((type) => ["sent", "approved_manager", "approved_internal", "client", "bump"].includes(type))) {
      return Array.isArray(post.copy_options) && post.copy_options.length > 1 ? "options" : "actions";
    }
    return "";
  };

  for (const member of (members || []).filter((item) => item.role !== "client")) {
    const email = member.email;
    const mine = prefs[email] || {};
    const wantsSlack = Boolean(mine.slack);
    if (!wantsSlack && !all.some((item) => item.email === email)) continue;
    const schedule = mine.bumpSchedule || DEFAULT_SCHEDULE;
    const commentMode = mine.commentMode || "mine";

    for (const post of posts || []) {
      const isMine = post.created_by === email;
      const mode = (mine.bumpModes || {})[post.client_id] || "mine";
      // Bumps go to whoever the post is waiting on, plus anyone who chose "Whole calendar" for that client.
      const waiting = waitingOn(post, adminEmail, finalEmail);
      // New posts get 3 hours before any bump, so nobody is bumped right after making a post.
      const created = (post.history || []).find((entry: any) => entry.type === "created");
      const settled = !created || now - created.at >= 3 * 3600000;
      const deleted = (post.history || []).some((entry: any) => entry.type === "deleted");
      if (!deleted && settled && post.post_date && stageOf(post) !== "approved" && mode !== "off" && (waiting.includes(email) || mode === "all")) {
        const [year, month, day] = post.post_date.split("-").map(Number);
        const passed = schedule.map((slot: any) => {
          const [hour, minute] = slot.time.split(":").map(Number);
          const [y, m, d] = bumpDay(year, month, day, slot.days);
          return pacificTime(y, m, d, hour, minute).getTime();
        }).filter((at: number) => at <= now && now - at < 3 * 86400000);
        if (passed.length) {
          const at = Math.max(...passed);
          if (await once("bump:" + post.id + ":" + email + ":" + at)) {
            await notify(email, wantsSlack, post, "BUMP", "Waiting on " + STAGE_NAMES[stageOf(post)] + ". Post date: " + shortDate(post.post_date), "actions");
          }
        }
      }
      // One message per person per burst of changes; it waits until they've paused.
      const byActor: Record<string, any[]> = {};
      for (const entry of post.history || []) {
        // Only what needs them: a step that leaves the post waiting on them, or a bump. General updates
        // (date moved, edits, approvals that don't need them) stay on the site, folded under "Updates on your posts".
        // Anyone who turned on "Notify me" for updates on their posts gets those too.
        const needsThem = mine.updatesMode === "notify" || entry.type === "bump" || (waiting.includes(email) && !["moved", "edited", "deleted"].includes(entry.type));
        const fresh = needsThem && entry.at && now - entry.at < WINDOW && entry.by !== email && (entry.to || []).includes(email);
        if (fresh && historyMessage(entry, post, email)) (byActor[entry.by] = byActor[entry.by] || []).push(entry);
      }
      for (const entries of Object.values(byActor)) {
        if (now - Math.max(...entries.map((entry) => entry.at)) < QUIET) continue;
        const fresh = [];
        for (const entry of entries) {
          if (await once("hist:" + post.id + ":" + email + ":" + entry.at + ":" + entry.type)) fresh.push(entry);
        }
        if (!fresh.length) continue;
        const messages = fresh.map((entry) => historyMessage(entry, post, email)!);
        const step = messages.find((_, index) => !["moved", "edited"].includes(fresh[index].type));
        const title = step ? step.title : messages.length > 1 ? "Changes to your post" : messages[0].title;
        await notify(email, wantsSlack, post, title, messages.map((message) => message.detail).join("\n"), spotFor(fresh.map((entry) => entry.type), post));
      }
      // "My posts": posts they made, and posts waiting on them.
      if (commentMode !== "off" && (commentMode === "all" || isMine || waiting.includes(email))) {
        for (const comment of notesByPost[post.id] || []) {
          const fresh = comment.at && now - comment.at < WINDOW && comment.by !== email;
          if (fresh && await once("comment:" + post.id + ":" + email + ":" + comment.at)) {
            const author = String(comment.by || "Someone").split("@")[0];
            await notify(email, wantsSlack, post, "New comment", author + ": " + comment.text, "comments");
          }
        }
      }
    }
  }

  // Deleted posts are removed for good by the site 30 minutes after deletion (this function only reads posts).
  await db.from("sent_notifications").delete().lt("sent_at", new Date(now - 7 * 86400000).toISOString());
  return Response.json({ sent });
});
