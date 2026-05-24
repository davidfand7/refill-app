import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type AgentInsert = Database["public"]["Tables"]["agents"]["Insert"];
type DeploymentInsert = Database["public"]["Tables"]["deployments"]["Insert"];

/**
 * Seeds realistic demo data the first time a user lands in the app.
 * Idempotent: skips if the user already has agents.
 */
const seedingInFlight = new Set<string>();

export async function seedDemoDataIfEmpty(userId: string) {
  if (seedingInFlight.has(userId)) return;
  seedingInFlight.add(userId);
  try {
    const { data: existing, error } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", userId)
      .limit(1);
    if (error) return;
    if (existing && existing.length > 0) return;
    await runSeed(userId);
  } finally {
    seedingInFlight.delete(userId);
  }
}

async function runSeed(userId: string) {

  const now = Date.now();
  const minutes = (n: number) => new Date(now - n * 60_000).toISOString();
  const hours = (n: number) => new Date(now - n * 3_600_000).toISOString();
  const days = (n: number) => new Date(now - n * 86_400_000).toISOString();

  const agentsPayload: AgentInsert[] = [
    {
      user_id: userId,
      name: "Inbox triage assistant",
      description: "Sorts incoming email by urgency and drafts replies for routine messages.",
      goal: "Keep my inbox under control by drafting replies to routine messages and surfacing anything that needs my attention.",
      behavior: { tone: "professional", autonomy: "suggest", tools: ["gmail", "calendar"] },
      permissions: [
        { name: "Read inbox", risk: "low", granted: true },
        { name: "Draft replies", risk: "low", granted: true },
        { name: "Send messages", risk: "elevated", granted: false },
      ],
      deployment_target: "openagentic_hosted",
      status: "live",
      risk_level: "low",
      readiness_score: 94,
      tags: ["productivity", "email"],
      approvals_pending: 2,
      last_run_at: minutes(12),
    },
    {
      user_id: userId,
      name: "Morning briefing",
      description: "Summarises calendar, key emails, and tasks each morning at 7am.",
      goal: "Send a short, structured briefing to my phone every morning at 7am.",
      behavior: { tone: "friendly", autonomy: "act", tools: ["calendar", "gmail", "telegram"] },
      permissions: [
        { name: "Read calendar", risk: "low", granted: true },
        { name: "Read inbox", risk: "low", granted: true },
        { name: "Send Telegram message", risk: "medium", granted: true },
      ],
      deployment_target: "claude",
      status: "live",
      risk_level: "low",
      readiness_score: 98,
      tags: ["routine", "personal"],
      approvals_pending: 0,
      last_run_at: hours(8),
    },
    {
      user_id: userId,
      name: "Lead qualifier",
      description: "Scores inbound leads against your ideal-customer profile and routes hot leads to the CRM.",
      goal: "Look up new website leads, score them, and create CRM records for the strong fits.",
      behavior: { tone: "neutral", autonomy: "act", tools: ["hubspot", "web"] },
      permissions: [
        { name: "Web research", risk: "low", granted: true },
        { name: "Write to CRM", risk: "elevated", granted: true },
      ],
      deployment_target: "openagentic_hosted",
      status: "ready",
      risk_level: "medium",
      readiness_score: 89,
      tags: ["sales"],
      approvals_pending: 1,
      last_run_at: hours(3),
    },
    {
      user_id: userId,
      name: "Site change watcher",
      description: "Watches a list of URLs and pings me when meaningful content shifts.",
      goal: "Watch competitor pricing pages and alert me to any meaningful change.",
      behavior: { tone: "neutral", autonomy: "suggest", tools: ["web", "telegram"] },
      permissions: [
        { name: "Fetch web pages", risk: "low", granted: true },
        { name: "Send Telegram message", risk: "medium", granted: true },
      ],
      deployment_target: "openclaw_self_hosted",
      status: "tested",
      risk_level: "low",
      readiness_score: 81,
      tags: ["operations"],
      approvals_pending: 0,
      last_run_at: hours(20),
    },
    {
      user_id: userId,
      name: "Customer chat operator",
      description: "Answers questions in our support Telegram group and escalates anything sensitive.",
      goal: "Reply to common product questions in the support Telegram channel during business hours.",
      behavior: { tone: "warm", autonomy: "act", tools: ["telegram", "knowledge_base"] },
      permissions: [
        { name: "Read messages", risk: "low", granted: true },
        { name: "Send messages", risk: "medium", granted: true },
        { name: "Escalate to human", risk: "low", granted: true },
      ],
      deployment_target: "openagentic_hosted",
      status: "draft",
      risk_level: "medium",
      readiness_score: 42,
      tags: ["support"],
      approvals_pending: 0,
      last_run_at: null,
    },
    {
      user_id: userId,
      name: "Research summarizer",
      description: "Reads long articles and returns a structured summary with citations.",
      goal: "Summarise any article I share with structured key points and source links.",
      behavior: { tone: "academic", autonomy: "act", tools: ["web"] },
      permissions: [{ name: "Fetch web pages", risk: "low", granted: true }],
      deployment_target: "claude",
      status: "draft",
      risk_level: "low",
      readiness_score: 0,
      tags: ["research"],
      approvals_pending: 0,
      last_run_at: null,
    },
  ];

  const { data: insertedAgents } = await supabase
    .from("agents")
    .insert(agentsPayload)
    .select("id, name, status, deployment_target");

  if (!insertedAgents) return;

  const agentByName = Object.fromEntries(insertedAgents.map((a) => [a.name, a]));

  // Self-hosted environment
  await supabase.from("self_hosted_environments").insert({
    user_id: userId,
    name: "Studio Mac mini",
    device_type: "mac_mini",
    status: "healthy",
    health: { cpu: 12, memory: 38, disk: 41, uptime_hours: 312 },
    security_level: "hardened",
    setup_progress: 100,
    last_check: minutes(4),
  });

  // Activity timeline
  const activity = [
    { type: "deploy.success", title: "Deployed to OpenAgentic Hosted", description: "Inbox triage assistant v3 went live.", agent_id: agentByName["Inbox triage assistant"]?.id, created_at: minutes(12) },
    { type: "approval.requested", title: "Approval needed", description: "Inbox triage wants to send a reply to acme@corp.com.", agent_id: agentByName["Inbox triage assistant"]?.id, created_at: minutes(38) },
    { type: "test.passed", title: "Test scenario passed", description: "Lead qualifier scored 89 on the 'enterprise inbound' scenario.", agent_id: agentByName["Lead qualifier"]?.id, created_at: hours(2) },
    { type: "agent.created", title: "Created Customer chat operator", description: "Draft saved, not yet tested.", agent_id: agentByName["Customer chat operator"]?.id, created_at: hours(5) },
    { type: "deploy.success", title: "Morning briefing ran", description: "Sent to Telegram at 7:00am.", agent_id: agentByName["Morning briefing"]?.id, created_at: hours(8) },
    { type: "warning.policy", title: "Policy warning", description: "Site change watcher attempted an unsupported tool — gracefully handled.", agent_id: agentByName["Site change watcher"]?.id, created_at: hours(20) },
    { type: "agent.updated", title: "Updated permissions", description: "Granted CRM write to Lead qualifier.", agent_id: agentByName["Lead qualifier"]?.id, created_at: days(1) },
  ].map((a) => ({ ...a, user_id: userId, metadata: {} }));

  await supabase.from("activity_events").insert(activity);

  // Deployments
  const deployments: DeploymentInsert[] = [
    {
      user_id: userId,
      agent_id: agentByName["Inbox triage assistant"]?.id,
      target: "openagentic_hosted",
      status: "success",
      progress: 100,
      log: [
        { ts: minutes(15), level: "info", msg: "Validating bundle" },
        { ts: minutes(14), level: "info", msg: "Uploading artifacts" },
        { ts: minutes(13), level: "info", msg: "Provisioning runtime" },
        { ts: minutes(12), level: "success", msg: "Agent live at hosted.openagentic.dev" },
      ],
      started_at: minutes(15),
      completed_at: minutes(12),
    },
    {
      user_id: userId,
      agent_id: agentByName["Morning briefing"]?.id,
      target: "claude",
      status: "success",
      progress: 100,
      log: [
        { ts: hours(9), level: "info", msg: "Compiling Claude project" },
        { ts: hours(9), level: "info", msg: "Pushing to Claude" },
        { ts: hours(8), level: "success", msg: "Available in your Claude workspace" },
      ],
      started_at: hours(9),
      completed_at: hours(8),
    },
  ];
  await supabase.from("deployments").insert(deployments);

  // Test runs
  await supabase.from("test_runs").insert([
    {
      user_id: userId,
      agent_id: agentByName["Lead qualifier"]?.id,
      scenario: "Enterprise inbound lead",
      status: "passed",
      score: 89,
      checklist: [
        { label: "Identified company size", passed: true },
        { label: "Looked up funding history", passed: true },
        { label: "Wrote CRM record", passed: true },
        { label: "Stayed within policy", passed: true },
      ],
      warnings: [{ target: "claude", message: "Claude target does not support CRM write — would skip step 3." }],
      logs: [
        { ts: hours(2), level: "info", msg: "Started scenario" },
        { ts: hours(2), level: "info", msg: "Researched company on the web" },
        { ts: hours(2), level: "success", msg: "Test passed with score 89" },
      ],
    },
  ]);

  // Approvals — pending + a few decided for history
  const inFuture = (n: number) => new Date(now + n * 60_000).toISOString();
  await supabase.from("approvals").insert([
    {
      user_id: userId,
      agent_id: agentByName["Inbox triage assistant"]?.id,
      action_type: "send_email",
      title: "Reply to acme@corp.com about renewal pricing",
      reason: "Acme asked for renewal pricing on their Pro plan. The draft uses our standard renewal template and the published Q2 price list.",
      affected_data: {
        to: "ops@acme-corp.com",
        subject: "Re: Renewal pricing for Acme Pro",
        body_preview: "Hi Jordan — happy to share renewal terms for your Pro plan. Based on your current seat count (24) the renewal would be $14,400/year, locked through Q2 2027…",
        attachments: [],
      },
      risk_level: "medium",
      status: "pending",
      expires_at: inFuture(45),
    },
    {
      user_id: userId,
      agent_id: agentByName["Inbox triage assistant"]?.id,
      action_type: "send_email",
      title: "Decline meeting request from unknown sender",
      reason: "Sender is not in your contacts and the message contains a vague pitch. Drafting a polite decline.",
      affected_data: {
        to: "meet@growthhackers.io",
        subject: "Re: Quick chat next week?",
        body_preview: "Thanks for reaching out. I'm not exploring this category right now — I'll keep your note on file. Best, …",
      },
      risk_level: "low",
      status: "pending",
      expires_at: inFuture(180),
    },
    {
      user_id: userId,
      agent_id: agentByName["Lead qualifier"]?.id,
      action_type: "crm_write",
      title: "Create CRM record for Northwind Logistics",
      reason: "Lead scored 92/100 against the enterprise ICP (1,200 employees, fits target vertical, recent funding round). Routing to the Enterprise pipeline.",
      affected_data: {
        crm: "HubSpot",
        pipeline: "Enterprise",
        company: "Northwind Logistics",
        score: 92,
        contact: { name: "Priya Shah", title: "VP Operations", email: "priya@northwind.co" },
      },
      risk_level: "elevated",
      status: "pending",
      expires_at: inFuture(120),
    },
    {
      user_id: userId,
      agent_id: agentByName["Morning briefing"]?.id,
      action_type: "post_message",
      title: "Post tomorrow's briefing earlier (6:30am instead of 7:00am)",
      reason: "You have an early flight on the calendar. Adjusting tomorrow's send time once, then reverting to the usual 7:00am.",
      affected_data: {
        channel: "Telegram — Personal",
        scheduled_for: "Tomorrow 06:30",
        scope: "One-time override",
      },
      risk_level: "low",
      status: "pending",
      expires_at: inFuture(600),
    },
    {
      user_id: userId,
      agent_id: agentByName["Site change watcher"]?.id,
      action_type: "post_message",
      title: "Alert: competitor pricing page changed",
      reason: "Detected a price update on competitor.com/pricing — Pro tier moved from $19 to $24. Drafting a Telegram alert with the diff.",
      affected_data: {
        channel: "Telegram — Competitive",
        diff: { tier: "Pro", before: "$19/mo", after: "$24/mo" },
        url: "https://competitor.com/pricing",
      },
      risk_level: "low",
      status: "pending",
      expires_at: inFuture(30),
    },
    // History — already decided
    {
      user_id: userId,
      agent_id: agentByName["Inbox triage assistant"]?.id,
      action_type: "send_email",
      title: "Reply to vendor invoice question",
      reason: "Routine accounts-payable reply confirming receipt.",
      affected_data: { to: "ap@vendor.com", subject: "Re: Invoice #88421" },
      risk_level: "low",
      status: "approved",
      expires_at: hours(-12),
      decided_at: hours(6),
      decided_note: null,
    },
    {
      user_id: userId,
      agent_id: agentByName["Lead qualifier"]?.id,
      action_type: "crm_write",
      title: "Create CRM record for student inquiry",
      reason: "Lead did not match ICP (individual, education segment).",
      affected_data: { crm: "HubSpot", company: "—", contact: { email: "j.lee@uni.edu" } },
      risk_level: "low",
      status: "rejected",
      expires_at: hours(-24),
      decided_at: hours(20),
      decided_note: "Out of ICP — keep on newsletter list only.",
    },
  ]);
}
