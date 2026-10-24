const $ = (id) => document.getElementById(id);
const identities = {
  builder: { name: "Ulla", role: "Builder", color: "#a99bff", initial: "UL" },
  mapper: { name: "Veliya", role: "Mapper", color: "#69d8d0", initial: "VM" },
  breaker: { name: "Veliya", role: "Breaker", color: "#ffbd78", initial: "VB" },
  coordinator: {
    name: "Coordinator",
    role: "Mission control",
    color: "#a6b4ca",
    initial: "TH",
  },
};
let run = null,
  source = null,
  selected = "",
  csrf = "",
  tab = "findings",
  cursor = 0,
  following = true,
  playback = null,
  generation = 0;
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const label = (state) => state.replaceAll("_", " ");
async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok)
    throw Error(
      `Request failed (${res.status}). Refresh the room and try again.`,
    );
  return res.json();
}
function fail(error) {
  $("error").textContent = error.message;
}
function stopPlayback() {
  clearInterval(playback);
  playback = null;
  $("play").textContent = "Replay";
}
async function archive() {
  const data = await request("/api/runs");
  csrf = data.csrf;
  $("runs").replaceChildren();
  for (const item of data.runs) {
    const a = node(
      "a",
      undefined,
      `run-link${item.id === selected ? " selected" : ""}`,
    );
    a.href = `#run=${item.id}`;
    a.append(
      node("strong", item.title.slice(0, 100)),
      node(
        "small",
        `${item.mock ? "MOCK · " : ""}${label(item.state)} · ${new Date(item.createdAt).toLocaleDateString()}`,
      ),
    );
    $("runs").append(a);
  }
  return data.runs;
}
function currentEvents() {
  return run.events.filter((e) => e.seq <= cursor);
}
function renderAgents(events, state) {
  $("agents").replaceChildren();
  for (const [id, who] of Object.entries(identities).filter(
    ([id]) => id !== "coordinator",
  )) {
    const last = events.filter((e) => e.agent === id).at(-1),
      activity = events.filter((e) => e.agent === id && e.activity).at(-1);
    const done = [
      "completed",
      "needs_attention",
      "budget_exceeded",
      "failed",
      "cancelled",
    ].includes(state);
    const working = !done && activity?.activity === "working";
    const card = node(
      "article",
      undefined,
      `agent${working ? " working" : ""}`,
    );
    card.dataset.agent = id;
    card.style.setProperty("--agent", who.color);
    const head = node("div", undefined, "agent-head"),
      avatar = node("span", who.initial, "avatar"),
      title = node("div");
    title.append(node("h3", who.role), node("small", who.name));
    head.append(
      avatar,
      title,
      node(
        "span",
        done
          ? "Run ended"
          : working
            ? "Working"
            : activity
              ? "Idle"
              : "Waiting",
        "activity-status",
      ),
    );
    card.append(
      head,
      node(
        "p",
        done
          ? `Run ended: ${label(state)}. See the final outcome and recorded evidence below.`
          : (last?.message ?? "No activity recorded yet."),
      ),
    );
    $("agents").append(card);
  }
}
function artifacts(events) {
  const refs = new Set(
    events.flatMap((e) => (e.refs ?? []).map((r) => `${r.type}:${r.id}`)),
  );
  const findings = new Map();
  for (const e of events) if (e.finding) findings.set(e.finding.id, e.finding);
  const legacy =
    following &&
    cursor === (run.events.at(-1)?.seq ?? 0) &&
    !run.events.some((e) => e.refs?.length);
  return {
    findings: legacy ? run.findings : [...findings.values()],
    patches: run.patches.filter((p) => legacy || refs.has(`patch:${p.round}`)),
    evidence: run.evidence.filter((e) => legacy || refs.has(`test:${e.id}`)),
  };
}
function showEvidence(type, id) {
  tab =
    type === "patch" ? "patches" : type === "test" ? "evidence" : "findings";
  renderEvidence(currentEvents());
  const target = document.getElementById(`artifact-${type}-${id}`);
  if (target) {
    target.scrollIntoView({ block: "nearest" });
    target.focus({ preventScroll: true });
  }
}
function renderEvidence(events) {
  for (const button of document.querySelectorAll("[data-tab]"))
    button.setAttribute("aria-pressed", String(button.dataset.tab === tab));
  const container = $("evidence");
  container.replaceChildren();
  const data = artifacts(events)[tab].slice().reverse();
  if (!data.length) {
    container.append(
      node(
        "p",
        "No evidence of this type recorded at this point in the mission.",
        "empty-evidence",
      ),
    );
    return;
  }
  for (const item of data) {
    const type =
      tab === "patches" ? "patch" : tab === "evidence" ? "test" : "finding";
    const article = node("article", undefined, "artifact");
    article.id = `artifact-${type}-${type === "patch" ? item.round : item.id}`;
    article.tabIndex = -1;
    if (type === "finding") {
      article.append(
        node(
          "h3",
          `${item.id} · ${item.status === "hypothesis" ? "SUSPECTED" : item.status.toUpperCase()} · ${item.severity}`,
        ),
        node("p", item.explanation),
        node(
          "p",
          `${item.file}:${item.location} · ${item.criterionId}`,
          "artifact-meta",
        ),
        node("p", `Suggested correction: ${item.suggestedCorrection}`),
      );
    }
    if (type === "patch") {
      article.append(
        node("h3", `Round ${item.round} · Reviewable diff`),
        node("p", item.revision, "artifact-meta"),
        node("pre", item.diff || "No changes from source revision."),
      );
    }
    if (type === "test") {
      article.append(
        node(
          "h3",
          `${item.checkId} · ${item.timedOut ? "TIMED OUT" : item.exitCode === 0 ? "PASSED" : item.exitCode === null ? "NOT EXECUTED" : "FAILED"}`,
        ),
        node(
          "p",
          `Exit ${item.exitCode ?? "unavailable"} · ${item.durationMs} ms · ${item.criterionIds.join(", ")}`,
        ),
        node(
          "p",
          `${item.revision === (events.at(-1)?.metrics?.revision ?? (following ? run.revision : "")) ? "Current" : "Earlier"} revision ${item.revision}`,
          "artifact-meta",
        ),
        node("pre", JSON.stringify(item.command)),
        node("pre", item.output || "(No output)"),
      );
    }
    container.append(article);
  }
}
function elapsed() {
  if (!run) return;
  const event = currentEvents().at(-1);
  const end =
    following && !run.terminal
      ? Date.now()
      : Date.parse(event?.at ?? run.createdAt);
  const seconds = Math.max(
    0,
    Math.floor((end - Date.parse(run.createdAt)) / 1000),
  );
  $("elapsed").textContent =
    `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
function render() {
  if (!run) return;
  const events = currentEvents(),
    last = events.at(-1),
    state = last?.state ?? "queued",
    metrics = last?.metrics;
  $("title").textContent = run.title;
  $("run-id").textContent =
    `MISSION ${run.id.slice(0, 8).toUpperCase()} / ${following ? "LIVE RECORD" : "CHRONOLOGICAL REPLAY"}`;
  $("status").textContent = label(state);
  $("mock").hidden = !run.mock;
  $("round").textContent =
    `${metrics?.round ?? (following ? run.round : "—")} / ${run.maxRounds}`;
  $("tokens").textContent =
    (metrics?.tokens ?? (following ? run.tokens : null))?.toLocaleString() ??
    "Not recorded";
  const cost = metrics ? metrics.cost : following ? run.cost : null;
  $("cost").textContent = cost === null ? "Unknown" : `$${cost.toFixed(4)}`;
  $("revision").textContent =
    (metrics?.revision ?? (following ? run.revision : "")).slice(0, 12) ||
    "Not recorded";
  $("cancel").disabled = run.terminal;
  $("report").href = `/api/runs/${run.id}/report`;
  $("report").title =
    "Download full public run report (all events, including later replay events)";
  const max = run.events.at(-1)?.seq ?? 1;
  $("cursor").max = String(max);
  $("cursor").value = String(cursor);
  $("position").textContent = `${cursor} / ${max}`;
  $("event-count").textContent = `${events.length} records`;
  const done = [
    "completed",
    "needs_attention",
    "budget_exceeded",
    "failed",
    "cancelled",
  ].includes(state);
  $("outcome").hidden = !done;
  $("outcome").dataset.success = String(state === "completed");
  $("outcome").textContent =
    `${label(state).toUpperCase()} — ${last?.message ?? run.reason}`;
  renderAgents(events, state);
  elapsed();
  const timeline = $("timeline"),
    near =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80,
    scroll = timeline.scrollTop;
  timeline.replaceChildren();
  for (const event of events) {
    const who = identities[event.agent ?? "coordinator"];
    const article = node("article", undefined, "event");
    article.dataset.seq = String(event.seq);
    article.style.setProperty("--agent", who.color);
    const meta = node("div", undefined, "event-meta");
    meta.append(
      node("strong", `${who.name} · ${who.role}`),
      node("time", new Date(event.at).toLocaleTimeString()),
    );
    article.append(meta, node("p", event.message));
    const links = node("div", undefined, "event-links");
    for (const ref of event.refs ?? []) {
      const button = node(
        "button",
        `${ref.type === "test" ? "Execution" : ref.type === "patch" ? "Diff" : "Finding"} ${ref.type === "test" ? ref.id.slice(0, 8) : ref.id}`,
      );
      button.dataset.ref = `${ref.type}:${ref.id}`;
      button.onclick = () => showEvidence(ref.type, ref.id);
      links.append(button);
    }
    article.append(links);
    timeline.append(article);
  }
  if (near && following) timeline.scrollTop = timeline.scrollHeight;
  else timeline.scrollTop = scroll;
  renderEvidence(events);
}
async function select(id) {
  const gen = ++generation;
  stopPlayback();
  source?.close();
  selected = id;
  $("error").textContent = "";
  $("connection").textContent = "Connecting…";
  try {
    const next = await request(`/api/runs/${id}`);
    if (gen !== generation) return;
    run = next;
    cursor = run.events.at(-1)?.seq ?? 0;
    following = true;
    $("empty").hidden = true;
    $("mission").hidden = false;
    render();
    await archive();
    if (gen !== generation) return;
    source = new EventSource(`/api/runs/${id}/events?after=${cursor}`);
    source.onopen = () => {
      $("connection").textContent = "● Connected · persisted events";
    };
    source.onerror = () => {
      $("connection").textContent = "Reconnecting · history retained";
    };
    source.addEventListener("snapshot", (event) => {
      if (gen !== generation) return;
      const next = JSON.parse(event.data);
      const unique = new Map(next.events.map((e) => [e.seq, e]));
      next.events = [...unique.values()].sort((a, b) => a.seq - b.seq);
      run = next;
      if (following) cursor = run.events.at(-1)?.seq ?? 0;
      render();
    });
  } catch (error) {
    fail(error);
    $("connection").textContent = "Unavailable";
  }
}
$("cancel").onclick = async () => {
  if (!run) return;
  const id = run.id;
  $("cancel").disabled = true;
  try {
    await request(`/api/runs/${id}/cancel`, {
      method: "POST",
      headers: { "X-TaskHeist-CSRF": csrf },
    });
    $("connection").textContent =
      "Cancellation requested · waiting for coordinator";
  } catch (error) {
    fail(error);
    $("cancel").disabled = false;
  }
};
$("cursor").oninput = () => {
  stopPlayback();
  following = false;
  cursor = Number($("cursor").value);
  render();
};
$("latest").onclick = () => {
  if (!run) return;
  stopPlayback();
  following = true;
  cursor = run.events.at(-1)?.seq ?? 0;
  render();
};
$("play").onclick = () => {
  if (!run) return;
  if (playback) {
    stopPlayback();
    return;
  }
  following = false;
  if (cursor >= (run.events.at(-1)?.seq ?? 0)) cursor = 1;
  render();
  $("play").textContent = "Pause";
  playback = setInterval(() => {
    const next = run.events.find((e) => e.seq > cursor);
    if (!next) {
      stopPlayback();
      return;
    }
    cursor = next.seq;
    render();
  }, 900);
};
for (const button of document.querySelectorAll("[data-tab]"))
  button.onclick = () => {
    tab = button.dataset.tab;
    if (run) renderEvidence(currentEvents());
  };
$("refresh").onclick = () => archive().catch(fail);
window.addEventListener("hashchange", () => {
  const id = new URLSearchParams(location.hash.slice(1)).get("run");
  if (id) void select(id);
});
setInterval(elapsed, 1000);
setInterval(() => {
  void archive()
    .then((runs) => {
      if (!run && runs.length) location.hash = `run=${runs[0].id}`;
    })
    .catch(() => {});
}, 5000);
archive()
  .then((runs) => {
    const id =
      new URLSearchParams(location.hash.slice(1)).get("run") ?? runs[0]?.id;
    if (id) void select(id);
    else $("connection").textContent = "Ready · no runs recorded";
  })
  .catch(fail);
