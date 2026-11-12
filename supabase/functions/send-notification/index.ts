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
const DEFAULT_SCHEDULE = [
  { days: 3, time: "10:00" }, { days: 2, time: "10:00" },
  { days: 1, time: "10:00" }, { days: 1, time: "15:00" },
];
const WINDOW = 10 * 60 * 1000;
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

function waitingOn(post: any, adminEmail: string) {
  const stage = stageOf(post);
  if (stage === "approved") return [];
  if (stage === "internal") return post.manager ? [post.manager] : [];
  const creator = post.created_by || adminEmail;
  return creator ? [creator] : [];
}

function historyMessage(entry: any, post: any) {
  const who = displayName(entry.by);
  const note = entry.note ? "\n\"" + entry.note + "\"" : "";
  switch (entry.type) {
    case "sent": return { title: "Ready for your review", detail: who + " sent this for review" + note };
    case "approved_internal": return { title: "Approved internally", detail: who + " approved it. Ready to send to client." };
    case "changes": return { title: "Changes requested", detail: who + " sent this back to Drafting" + note };
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
  const clientName = Object.fromEntries((clients || []).map((client) => [client.id, client.name]));
  const prefs = Object.fromEntries((preferences || []).map((row) => [row.email, row.data || {}]));
  const notesByPost = Object.fromEntries((notes || []).map((row) => [row.post_id, row.comments || []]));
  let sent = 0;

  const notify = async (email: string, wantsSlack: boolean, post: any, title: string, detail: string) => {
    const name = post.title + " · " + (clientName[post.client_id] || "");
    sent += await send(all, email, { title, body: name, url: "/#post-" + post.id });
    if (wantsSlack && await sendSlack(email, title, [name, ...String(detail).split("\n")], SITE + "/#post-" + post.id)) sent++;
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
      // Bumps only go to the coordinator who made the post, never to managers.
      const creator = post.created_by || adminEmail;
      if (post.post_date && stageOf(post) !== "approved" && mode !== "off" && creator === email) {
        const [year, month, day] = post.post_date.split("-").map(Number);
        const passed = schedule.map((slot: any) => {
          const [hour, minute] = slot.time.split(":").map(Number);
          return pacificTime(year, month, day - slot.days, hour, minute).getTime();
        }).filter((at: number) => at <= now && now - at < 3 * 86400000);
        if (passed.length) {
          const at = Math.max(...passed);
          if (await once("bump:" + post.id + ":" + email + ":" + at)) {
            await notify(email, wantsSlack, post, "BUMP", "Waiting on " + STAGE_NAMES[stageOf(post)] + ". Post date: " + shortDate(post.post_date));
          }
        }
      }
      for (const entry of post.history || []) {
        const fresh = entry.at && now - entry.at < WINDOW && entry.by !== email && (entry.to || []).includes(email);
        const message = fresh ? historyMessage(entry, post) : null;
        if (message && await once("hist:" + post.id + ":" + email + ":" + entry.at)) {
          await notify(email, wantsSlack, post, message.title, message.detail);
        }
      }
      if (commentMode !== "off" && (commentMode === "all" || isMine)) {
        for (const comment of notesByPost[post.id] || []) {
          const fresh = comment.at && now - comment.at < WINDOW && comment.by !== email;
          if (fresh && await once("comment:" + post.id + ":" + email + ":" + comment.at)) {
            const author = String(comment.by || "Someone").split("@")[0];
            await notify(email, wantsSlack, post, "New comment", author + ": " + comment.text);
          }
        }
      }
    }
  }

  await db.from("sent_notifications").delete().lt("sent_at", new Date(now - 7 * 86400000).toISOString());
  return Response.json({ sent });
});
