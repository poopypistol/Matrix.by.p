// declan: sends scheduled bumps to Slack.
// Runs every 5 minutes (see supabase/bumps.sql). Each bump goes out once per person, post and time slot.
// Goes only to the coordinator who made the post, on their bump schedule, unless they turned bumps off
// for that client. Only people who turned Slack on in Settings get them.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SITE = "https://declanbyp.vercel.app";
const DEFAULT_SCHEDULE = [
  { days: 3, time: "10:00" }, { days: 2, time: "10:00" }, { days: 1, time: "10:00" }, { days: 1, time: "15:00" }
];
const CATCH_UP_MS = 2 * 60 * 60 * 1000; // a slot missed by up to 2 hours still goes out
const STAGE_NAMES: Record<string, string> = {
  draft: "Drafting", internal: "In review", ready: "Ready to send", client: "Sent to client"
};

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const slackToken = Deno.env.get("SLACK_BOT_TOKEN") || "";

function pacificTime(year: number, month: number, day: number, hour: number) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour));
  const parts: Record<string, number> = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric"
  }).formatToParts(guess).forEach((part) => { parts[part.type] = Number(part.value); });
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour) - guess.getTime();
  return new Date(guess.getTime() - offset);
}

function bumpTimes(postDate: string, schedule: { days: number; time: string }[]) {
  const [year, month, day] = postDate.split("-").map(Number);
  return schedule.map(({ days, time }) => {
    const [hour, minute] = time.split(":").map(Number);
    return new Date(pacificTime(year, month, day - days, hour).getTime() + minute * 60000);
  });
}

async function slack(method: string, body: Record<string, unknown>) {
  const response = await fetch("https://slack.com/api/" + method, {
    method: "POST",
    headers: { Authorization: "Bearer " + slackToken, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function slackUser(email: string) {
  const response = await fetch("https://slack.com/api/users.lookupByEmail?email=" + encodeURIComponent(email), {
    headers: { Authorization: "Bearer " + slackToken }
  });
  const data = await response.json();
  return data.ok ? data.user.id as string : null;
}

function prettyDate(postDate: string) {
  const [year, month, day] = postDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC"
  });
}

Deno.serve(async () => {
  if (!slackToken) return Response.json({ sent: 0, problem: "SLACK_BOT_TOKEN is missing" });
  const now = new Date();

  const [{ data: posts }, { data: members }, { data: prefs }, { data: clients }] = await Promise.all([
    db.from("posts").select("id, client_id, title, post_date, post_time, stage, manager, created_by"),
    db.from("members").select("email, role"),
    db.from("preferences").select("email, data"),
    db.from("clients").select("id, name")
  ]);

  const team = (members || []).filter((person) => person.role !== "client");
  const admin = (team.find((person) => person.role === "admin") || {}).email || "";
  const clientName = Object.fromEntries((clients || []).map((client) => [client.id, client.name]));
  const prefsBy = Object.fromEntries((prefs || []).map((row) => [row.email, row.data || {}]));

  const waitingOn = (post: any) => {
    const stage = post.stage || "draft";
    if (stage === "approved") return [];
    if (stage === "internal") return post.manager ? [post.manager] : [];
    const creator = post.created_by || admin;
    return creator ? [creator] : [];
  };

  let sent = 0;
  for (const person of team) {
    const pref = prefsBy[person.email] || {};
    if (!pref.slack) continue;
    const schedule = Array.isArray(pref.bumpSchedule) && pref.bumpSchedule.length ? pref.bumpSchedule : DEFAULT_SCHEDULE;
    const modes = pref.bumpModes || {};
    let userId: string | null | undefined;

    for (const post of posts || []) {
      if (!post.post_date || !clientName[post.client_id] || (post.stage || "draft") === "approved") continue;
      // Bumps only go to the coordinator who made the post, never to managers.
      if ((modes[post.client_id] || "mine") === "off") continue;
      if ((post.created_by || admin) !== person.email) continue;
      const waiting = waitingOn(post);

      const due = bumpTimes(post.post_date, schedule)
        .filter((slot) => slot <= now && now.getTime() - slot.getTime() <= CATCH_UP_MS);
      for (const slot of due) {
        const { error: taken } = await db.from("bump_sent").insert({ email: person.email, post_id: String(post.id), slot: slot.toISOString() });
        if (taken) continue; // already sent for this slot

        if (userId === undefined) userId = await slackUser(person.email);
        if (!userId) {
          await db.from("bump_sent").delete().match({ email: person.email, post_id: String(post.id), slot: slot.toISOString() });
          break;
        }
        const who = waiting.includes(person.email) ? "you" : (waiting[0] || "someone").split("@")[0];
        const stage = STAGE_NAMES[post.stage || "draft"] || "Drafting";
        const link = SITE + "/#post-" + post.id;
        const text = `Bump: *${post.title || "Untitled post"}* for ${clientName[post.client_id]} posts ${prettyDate(post.post_date)} and isn't approved yet. It's waiting on ${who} (${stage}). <${link}|Open in declan>`;
        const result = await slack("chat.postMessage", { channel: userId, text });
        if (result.ok) sent++;
        else await db.from("bump_sent").delete().match({ email: person.email, post_id: String(post.id), slot: slot.toISOString() });
      }
    }
  }
  return Response.json({ sent });
});
