#!/usr/bin/env python3
"""
Token measurement harness for req framework workflow simulation.

Simulates a complete workflow on the quickstart example, measuring token cost
per step under two approaches:

  OLD: AI reads full command markdown + all referenced files each turn
  NEW: AI reads thin wrapper markdown + only AI-required sections + CLI JSON

Produces a markdown report with per-command and per-step breakdowns.

Usage:
    python3 framework/scripts/measure-tokens.py [--output docs/measurement-phase0-baseline.md]
"""

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime

# ---------------------------------------------------------------------------
# Token estimation (heuristic — tiktoken unavailable in this environment)
# ---------------------------------------------------------------------------
# Claude tokenizer approximation for mixed CJK/English markdown:
#   - CJK characters: ~1 token each (sometimes 0.7)
#   - ASCII/Latin: ~4 chars per token
#   - Markdown formatting, whitespace: ~5 chars per token

CJK_RANGES = [
    (0x4E00, 0x9FFF),    # CJK Unified Ideographs
    (0x3400, 0x4DBF),    # CJK Unified Ideographs Extension A
    (0x3000, 0x303F),    # CJK Symbols and Punctuation
    (0xFF00, 0xFFEF),    # Fullwidth Forms
    (0xFE30, 0xFE4F),    # CJK Compatibility Forms
]


def is_cjk(ch):
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in CJK_RANGES)


def estimate_tokens(text: str) -> int:
    """Estimate token count for mixed CJK/English text."""
    cjk_chars = sum(1 for ch in text if is_cjk(ch))
    non_cjk_chars = len(text) - cjk_chars
    # CJK: ~0.8 tokens per char (some chars split, some merge)
    # Non-CJK: ~0.25 tokens per char (4 chars/token)
    return int(cjk_chars * 0.8 + non_cjk_chars * 0.25)


def read_file_tokens(path: Path) -> tuple[int, int]:
    """Read file, return (byte_count, estimated_tokens). Returns (0,0) if missing."""
    if not path.is_file():
        return 0, 0
    text = path.read_text(encoding="utf-8", errors="replace")
    return len(text.encode("utf-8")), estimate_tokens(text)


# ---------------------------------------------------------------------------
# Per-command D/A classification
# ---------------------------------------------------------------------------
# Based on the detailed Explore agent audit. Each entry:
#   d_ratio: fraction of Behavior section that is Deterministic (0.0-1.0)
#   total_steps: total behavior steps
#   d_steps / a_steps: counts from audit
#   wrapper_bytes: estimated size of thin-wrapper markdown in NEW approach

@dataclass
class CommandProfile:
    name: str
    d_ratio: float       # fraction of behavior that is deterministic
    d_steps: int
    a_steps: int
    s_steps: int = 0
    wrapper_bytes: int = 800  # default thin wrapper size
    notes: str = ""

    @property
    def total_steps(self):
        return self.d_steps + self.s_steps + self.a_steps

    @property
    def a_ratio(self):
        return 1.0 - self.d_ratio


COMMAND_PROFILES = {
    "intake":           CommandProfile("intake",           0.78, 7, 1, 1, 900,  "AI: one-sentence summary + persona inference"),
    "research":         CommandProfile("research",         1.00, 5, 0, 0, 600,  "100% D: subagent delegation + branch table"),
    "translate":        CommandProfile("translate",        0.75, 6, 2, 0, 1000, "AI: persona identification + User Story generation"),
    "detect-conflicts": CommandProfile("detect-conflicts", 1.00, 4, 0, 0, 500,  "100% D: subagent delegation"),
    "resolve-conflict": CommandProfile("resolve-conflict", 0.86, 6, 1, 0, 900,  "AI: impact matrix + trade-off analysis"),
    "review":           CommandProfile("review",           1.00, 12, 0, 0, 800,  "100% D: checklist + Decision Brief + AskUserQuestion"),
    "plan":             CommandProfile("plan",             0.92, 11, 1, 0, 1200, "AI: plan architecture generation (§6)"),
    "implement":        CommandProfile("implement",        0.55, 6, 5, 0, 1200, "AI: code + test generation, auto-fix"),
    "deploy":           CommandProfile("deploy",           1.00, 15, 0, 0, 800,  "100% D: pre-checks + health checks + rollback"),
    "feedback":         CommandProfile("feedback",         0.89, 8, 0, 1, 800,  "S: triage recommendation"),
    "iterate":          CommandProfile("iterate",          0.93, 13, 1, 0, 1000, "AI: impact analysis"),
    "audit":            CommandProfile("audit",            1.00, 9, 0, 0, 600,  "100% D: grep + diff + report generation"),
    "autonomy":         CommandProfile("autonomy",         1.00, 5, 0, 0, 400,  "100% D: config read/write + matrix print"),
    "onboard":          CommandProfile("onboard",          1.00, 5, 0, 0, 500,  "100% D: subagent delegation"),
}

# ---------------------------------------------------------------------------
# Workflow simulation steps
# ---------------------------------------------------------------------------
# Each step in a typical workflow on the quickstart example.
# files_read: list of files AI would read (via Read tool) during that step
# always_loaded: files that are in the system prompt / always in context

@dataclass
class WorkflowStep:
    name: str
    command: str
    description: str
    files_read: list = field(default_factory=list)
    agents_md_sections: list = field(default_factory=list)  # which §sections are read
    constitution_read: bool = False
    notes: str = ""


def build_quickstart_workflow(data_root: Path, fw_root: Path) -> list[WorkflowStep]:
    """Build a realistic 7-step workflow for the quickstart example."""
    specs = data_root / "specs" / "001-custom-slug"
    return [
        WorkflowStep(
            name="1. Intake",
            command="intake",
            description="User submits raw requirement",
            files_read=[
                data_root / "intake" / "raw" / "2026-04-08-add-custom-slug.md",
            ],
            agents_md_sections=["§1", "§5", "§5b", "§6"],
            notes="AI generates one-sentence summary + infers personas",
        ),
        WorkflowStep(
            name="2. Research",
            command="research",
            description="Subagent scans for duplicates",
            files_read=[
                data_root / "intake" / "raw" / "2026-04-08-add-custom-slug.md",
                # subagent reads specs/* but that's in subagent context, not parent
            ],
            agents_md_sections=["§5", "§5a", "§5b"],
            notes="Parent only sees subagent summary; branching is lookup table",
        ),
        WorkflowStep(
            name="3. Translate",
            command="translate",
            description="AI converts raw intake to structured spec",
            files_read=[
                data_root / "intake" / "raw" / "2026-04-08-add-custom-slug.md",
                data_root / "personas" / "end-user.md",
                data_root / "personas" / "admin.md",
                fw_root / "templates" / "spec" / "spec.md",
            ],
            agents_md_sections=["§1", "§3", "§4", "§5", "§6"],
            notes="AI: identify personas, generate User Stories + acceptance criteria",
        ),
        WorkflowStep(
            name="4. Detect Conflicts",
            command="detect-conflicts",
            description="Subagent scans spec for cross-persona conflicts",
            files_read=[
                specs / "spec.md",
            ],
            agents_md_sections=["§2", "§5", "§5b"],
            notes="100% delegation to subagent; parent is thin wrapper",
        ),
        WorkflowStep(
            name="5. Resolve Conflict",
            command="resolve-conflict",
            description="Human chooses resolution direction",
            files_read=[
                specs / "spec.md",
                data_root / "conflicts" / "CONFLICT-001-rate-limit.md",
                data_root / "personas" / "end-user.md",
                data_root / "personas" / "admin.md",
            ],
            agents_md_sections=["§2", "§5", "§6"],
            notes="AI: trade-off analysis + impact matrix; rest is D",
        ),
        WorkflowStep(
            name="6. Review",
            command="review",
            description="Human reviews and approves spec",
            files_read=[
                specs / "spec.md",
                specs / "research.md",
                data_root / "conflicts" / "CONFLICT-001-rate-limit.md",
            ],
            agents_md_sections=["§5", "§6"],
            notes="100% D: checklist checks + Decision Brief + AskUserQuestion",
        ),
        WorkflowStep(
            name="7. Plan",
            command="plan",
            description="AI generates technical plan",
            files_read=[
                specs / "spec.md",
                specs / "research.md",
                data_root / "conflicts" / "CONFLICT-001-rate-limit.md",
                fw_root / "templates" / "spec" / "plan.md",
                fw_root / "templates" / "spec" / "deployment-checklist.md",
            ],
            agents_md_sections=["§3", "§4", "§5", "§5a", "§6"],
            constitution_read=True,
            notes="AI: plan architecture generation; rest is D (prereqs, templates, Brief)",
        ),
    ]


# ---------------------------------------------------------------------------
# Measurement engine
# ---------------------------------------------------------------------------

@dataclass
class StepMeasurement:
    step: WorkflowStep
    # OLD approach
    old_command_tokens: int = 0
    old_agents_tokens: int = 0
    old_constitution_tokens: int = 0
    old_files_tokens: int = 0
    # NEW approach
    new_command_tokens: int = 0  # thin wrapper
    new_agents_tokens: int = 0  # only AI-required sections
    new_constitution_tokens: int = 0
    new_files_tokens: int = 0   # same files, but some reads replaced by CLI JSON
    new_cli_output_tokens: int = 50  # estimated CLI JSON output tokens per D-step

    @property
    def old_total(self):
        return self.old_command_tokens + self.old_agents_tokens + self.old_constitution_tokens + self.old_files_tokens

    @property
    def new_total(self):
        return self.new_command_tokens + self.new_agents_tokens + self.new_constitution_tokens + self.new_files_tokens + self.new_cli_output_tokens

    @property
    def saving(self):
        return self.old_total - self.new_total

    @property
    def saving_pct(self):
        return (self.saving / self.old_total * 100) if self.old_total > 0 else 0


def measure_workflow(
    fw_root: Path,
    data_root: Path,
    agents_md_path: Path,
    constitution_path: Path,
) -> list[StepMeasurement]:
    """Measure token cost for each workflow step under old and new approaches."""

    # Pre-read AGENTS.md and CONSTITUTION.md
    agents_bytes, agents_tokens = read_file_tokens(agents_md_path)
    const_bytes, const_tokens = read_file_tokens(constitution_path)

    # Estimate per-section tokens for AGENTS.md (rough: §1-§6 is first 60%, §5a-§5b is 15%)
    # For simplicity, assign proportional tokens to sections
    agents_section_tokens = {
        "§1": int(agents_tokens * 0.08),
        "§2": int(agents_tokens * 0.08),
        "§3": int(agents_tokens * 0.10),
        "§4": int(agents_tokens * 0.06),
        "§5": int(agents_tokens * 0.15),
        "§5a": int(agents_tokens * 0.10),
        "§5b": int(agents_tokens * 0.12),
        "§6": int(agents_tokens * 0.10),
    }

    # Read command files
    cmd_dir = fw_root / "commands"

    steps = build_quickstart_workflow(data_root, fw_root)
    measurements = []

    for step in steps:
        m = StepMeasurement(step=step)
        profile = COMMAND_PROFILES.get(step.command)
        if not profile:
            measurements.append(m)
            continue

        # --- OLD approach ---
        cmd_path = cmd_dir / f"{step.command}.md"
        cmd_bytes, cmd_tokens = read_file_tokens(cmd_path)
        m.old_command_tokens = cmd_tokens

        # AGENTS.md sections read
        for sec in step.agents_md_sections:
            m.old_agents_tokens += agents_section_tokens.get(sec, 0)

        # CONSTITUTION.md
        if step.constitution_read:
            m.old_constitution_tokens = const_tokens

        # Referenced files
        for fpath in step.files_read:
            _, ftokens = read_file_tokens(fpath)
            m.old_files_tokens += ftokens

        # --- NEW approach ---
        # Command markdown shrinks to thin wrapper
        m.new_command_tokens = int(profile.wrapper_bytes * 0.25)  # rough: 0.25 tokens/byte for wrappers

        # AGENTS.md: only sections needed for AI-judgment steps remain
        # If command is 100% D, AI doesn't need AGENTS.md at all (script enforces)
        # If command has AI steps, only AI-relevant sections needed
        if profile.a_steps > 0 or profile.s_steps > 0:
            for sec in step.agents_md_sections:
                # Only AI-relevant sections (§3 code gen, §2 conflict detect, §1 translation)
                if sec in ("§1", "§2", "§3"):
                    m.new_agents_tokens += agents_section_tokens.get(sec, 0)
                # §5, §5a, §5b, §6 are enforcement rules — script handles them
        # else: 0 AGENTS.md tokens (all enforced by script)

        # CONSTITUTION.md: still needed if command explicitly reads it for AI judgment
        if step.constitution_read and profile.a_steps > 0:
            m.new_constitution_tokens = const_tokens

        # Files: same files needed, but some reads are replaced by CLI JSON
        # For D-heavy commands, many file reads become `req spec status` calls
        # Conservatively: files_tokens * a_ratio (AI only needs files for AI work)
        m.new_files_tokens = int(m.old_files_tokens * profile.a_ratio)
        # But spec.md is always needed for AI context
        if profile.a_steps > 0:
            spec_path = data_root / "specs" / "001-custom-slug" / "spec.md"
            _, spec_tokens = read_file_tokens(spec_path)
            m.new_files_tokens = max(m.new_files_tokens, spec_tokens)

        # CLI JSON output tokens (small fixed cost per D-step)
        m.new_cli_output_tokens = profile.d_steps * 40  # ~40 tokens per CLI JSON response

        measurements.append(m)

    return measurements


# ---------------------------------------------------------------------------
# Per-command summary (all 14 commands, not just workflow steps)
# ---------------------------------------------------------------------------

@dataclass
class CommandMeasurement:
    name: str
    total_bytes: int
    total_tokens: int
    d_ratio: float
    d_tokens: int
    a_tokens: int
    new_tokens: int  # wrapper + a_tokens
    saving: int
    saving_pct: float
    profile: CommandProfile


def measure_all_commands(fw_root: Path) -> list[CommandMeasurement]:
    """Measure every command file and compute old vs new token counts."""
    cmd_dir = fw_root / "commands"
    results = []
    for name, profile in sorted(COMMAND_PROFILES.items()):
        path = cmd_dir / f"{name}.md"
        total_bytes, total_tokens = read_file_tokens(path)
        d_tokens = int(total_tokens * profile.d_ratio)
        a_tokens = total_tokens - d_tokens
        wrapper_tokens = int(profile.wrapper_bytes * 0.25)
        new_tokens = wrapper_tokens + a_tokens
        saving = total_tokens - new_tokens
        saving_pct = (saving / total_tokens * 100) if total_tokens > 0 else 0
        results.append(CommandMeasurement(
            name=name,
            total_bytes=total_bytes,
            total_tokens=total_tokens,
            d_ratio=profile.d_ratio,
            d_tokens=d_tokens,
            a_tokens=a_tokens,
            new_tokens=new_tokens,
            saving=saving,
            saving_pct=saving_pct,
            profile=profile,
        ))
    return results


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def generate_report(
    cmd_measurements: list[CommandMeasurement],
    workflow_measurements: list[StepMeasurement],
    agents_tokens: int,
    constitution_tokens: int,
) -> str:
    lines = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    lines.append("# Token Measurement — Phase 0 Baseline Report")
    lines.append("")
    lines.append(f"> Generated: {now}")
    lines.append("> Method: heuristic token estimation (CJK ~0.8 tok/char, ASCII ~0.25 tok/char)")
    lines.append("> Approach: OLD = full AI-interpreted markdown; NEW = thin wrapper + `req` CLI for D-sections")
    lines.append("")

    # --- Section 1: Per-command summary ---
    lines.append("## 1. Per-Command Token Analysis (14 commands)")
    lines.append("")
    lines.append("Each command's markdown is classified into D (Deterministic — scriptable) and A (AI-required) sections.")
    lines.append("")
    lines.append("| Command | Bytes | OLD tokens | D ratio | D tokens | A tokens | NEW tokens | Saving | Saving % |")
    lines.append("|---------|-------|-----------|---------|----------|----------|-----------|--------|----------|")

    total_old = total_new = 0
    for cm in cmd_measurements:
        lines.append(
            f"| `{cm.name}` | {cm.total_bytes:,} | {cm.total_tokens:,} | "
            f"{cm.d_ratio:.0%} | {cm.d_tokens:,} | {cm.a_tokens:,} | "
            f"{cm.new_tokens:,} | {cm.saving:,} | {cm.saving_pct:.0f}% |"
        )
        total_old += cm.total_tokens
        total_new += cm.new_tokens

    total_saving = total_old - total_new
    total_pct = (total_saving / total_old * 100) if total_old > 0 else 0
    lines.append(
        f"| **Total** | | **{total_old:,}** | | | | "
        f"**{total_new:,}** | **{total_saving:,}** | **{total_pct:.0f}%** |"
    )
    lines.append("")

    # Highlight 100% D commands
    full_d = [cm for cm in cmd_measurements if cm.d_ratio >= 1.0]
    lines.append(f"**100% Deterministic commands ({len(full_d)}/14)**:")
    for cm in full_d:
        lines.append(f"- `/{cm.name}` ({cm.total_tokens:,} tokens → {cm.new_tokens:,}, save {cm.saving_pct:.0f}%)")
    lines.append("")

    # --- Section 2: Always-loaded context ---
    lines.append("## 2. Always-Loaded Context (per session)")
    lines.append("")
    lines.append("These files may be read by multiple commands per session:")
    lines.append("")
    lines.append(f"| File | Tokens |")
    lines.append(f"|------|--------|")
    lines.append(f"| `AGENTS.md` | {agents_tokens:,} |")
    lines.append(f"| `CONSTITUTION.md` | {constitution_tokens:,} |")
    lines.append(f"| **Combined** | **{agents_tokens + constitution_tokens:,}** |")
    lines.append("")
    lines.append("In the OLD approach, AI re-reads relevant sections per command. In the NEW approach,")
    lines.append("enforcement sections (§5b autonomy matrix, §6 state machine) are handled by scripts —")
    lines.append("AI only reads semantic sections (§1 Translation, §2 Conflicts, §3 Code Gen) when needed.")
    lines.append("")

    # --- Section 3: Workflow simulation ---
    lines.append("## 3. Workflow Simulation (quickstart: intake → plan)")
    lines.append("")
    lines.append("Simulates 7 steps of a typical feature cycle on `examples/quickstart/`.")
    lines.append("")
    lines.append("| Step | Command | OLD tokens | NEW tokens | Saving | Saving % | Notes |")
    lines.append("|------|---------|-----------|-----------|--------|----------|-------|")

    wf_old_total = wf_new_total = 0
    for wm in workflow_measurements:
        lines.append(
            f"| {wm.step.name} | `{wm.step.command}` | "
            f"{wm.old_total:,} | {wm.new_total:,} | "
            f"{wm.saving:,} | {wm.saving_pct:.0f}% | {wm.step.notes} |"
        )
        wf_old_total += wm.old_total
        wf_new_total += wm.new_total

    wf_saving = wf_old_total - wf_new_total
    wf_pct = (wf_saving / wf_old_total * 100) if wf_old_total > 0 else 0
    lines.append(
        f"| **Total** | | **{wf_old_total:,}** | **{wf_new_total:,}** | "
        f"**{wf_saving:,}** | **{wf_pct:.0f}%** | |"
    )
    lines.append("")

    # --- Section 4: Per-step breakdown ---
    lines.append("## 4. Per-Step Breakdown")
    lines.append("")
    for wm in workflow_measurements:
        lines.append(f"### {wm.step.name} (`/req-{wm.step.command}`)")
        lines.append("")
        lines.append(f"| Component | OLD tokens | NEW tokens |")
        lines.append(f"|-----------|-----------|-----------|")
        lines.append(f"| Command markdown | {wm.old_command_tokens:,} | {wm.new_command_tokens:,} |")
        lines.append(f"| AGENTS.md sections | {wm.old_agents_tokens:,} | {wm.new_agents_tokens:,} |")
        lines.append(f"| CONSTITUTION.md | {wm.old_constitution_tokens:,} | {wm.new_constitution_tokens:,} |")
        lines.append(f"| Referenced files | {wm.old_files_tokens:,} | {wm.new_files_tokens:,} |")
        lines.append(f"| CLI JSON output | — | {wm.new_cli_output_tokens:,} |")
        lines.append(f"| **Total** | **{wm.old_total:,}** | **{wm.new_total:,}** |")
        lines.append("")

    # --- Section 5: Decision data ---
    lines.append("## 5. Decision Data — Should we proceed with Phase 1?")
    lines.append("")
    lines.append("### Token savings")
    lines.append(f"- **Per feature cycle** (7 steps): {wf_saving:,} tokens saved ({wf_pct:.0f}%)")
    lines.append(f"- **Per 5 features/month**: ~{wf_saving * 5:,} tokens/month")
    lines.append(f"- **Per 50 features/month**: ~{wf_saving * 50:,} tokens/month")
    lines.append("")
    lines.append("### Command markdown compression")
    lines.append(f"- **Total command markdown**: {total_old:,} tokens (OLD) → {total_new:,} tokens (NEW)")
    lines.append(f"- **Compression**: {total_pct:.0f}% reduction")
    lines.append("")

    # Rank commands by saving
    ranked = sorted(cmd_measurements, key=lambda c: c.saving, reverse=True)
    lines.append("### Top 5 commands by token saving potential")
    lines.append("")
    lines.append("| Rank | Command | D ratio | Saving | Why |")
    lines.append("|------|---------|---------|--------|-----|")
    for i, cm in enumerate(ranked[:5], 1):
        lines.append(
            f"| {i} | `{cm.name}` | {cm.d_ratio:.0%} | "
            f"{cm.saving:,} tokens | {cm.profile.notes} |"
        )
    lines.append("")

    # Rule-base vs AI verdict
    lines.append("### Rule-base vs AI verdict per command")
    lines.append("")
    lines.append("| Command | Verdict | Rationale |")
    lines.append("|---------|---------|-----------|")
    for cm in sorted(cmd_measurements, key=lambda c: c.name):
        if cm.d_ratio >= 1.0:
            verdict = "**Script 100%**"
            rationale = "No AI judgment needed. Entire command can be a shell/Python script."
        elif cm.d_ratio >= 0.85:
            verdict = "Script + thin AI"
            rationale = f"~{cm.d_ratio:.0%} scriptable. AI only for: {cm.profile.notes}"
        elif cm.d_ratio >= 0.70:
            verdict = "Hybrid"
            rationale = f"~{cm.d_ratio:.0%} scriptable. AI needed for: {cm.profile.notes}"
        else:
            verdict = "AI-primary"
            rationale = f"Only {cm.d_ratio:.0%} scriptable. Core work is AI: {cm.profile.notes}"
        lines.append(f"| `{cm.name}` | {verdict} | {rationale} |")
    lines.append("")

    # --- Section 6: Caveats ---
    lines.append("## 6. Caveats & Limitations")
    lines.append("")
    lines.append("1. **Token counts are estimates**: uses heuristic (CJK ~0.8 tok/char, ASCII ~0.25 tok/char),")
    lines.append("   not the actual Claude tokenizer. Real counts may differ by 10-20%.")
    lines.append("2. **AI output tokens not measured**: this only measures input context (what AI reads).")
    lines.append("   AI output (generated User Stories, plan sections, Decision Briefs) is a separate cost.")
    lines.append("3. **AGENTS.md section proportions are estimated**: sections aren't clearly byte-delimited;")
    lines.append("   proportions are rough.")
    lines.append("4. **Subagent tokens excluded**: `/research`, `/detect-conflicts`, `/onboard` delegate to")
    lines.append("   subagents. Their token cost is separate from the parent command and not reduced by scripting.")
    lines.append("5. **Tool call overhead excluded**: each Bash/Read/Edit tool invocation has ~50-100 tokens of")
    lines.append("   schema overhead. The NEW approach may have more tool calls (CLI invocations) that partially")
    lines.append("   offset the context savings.")
    lines.append("6. **This is a single-pass simulation**: real sessions may re-read files, retry, or branch.")
    lines.append("   Actual savings could be higher (re-reads avoided) or lower (more branching).")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Token measurement harness")
    parser.add_argument(
        "--output",
        default=None,
        help="Write report to this file (default: stdout)",
    )
    args = parser.parse_args()

    # Locate framework root
    script_path = Path(__file__).resolve()
    # Could be framework/scripts/measure-tokens.py
    fw_root = script_path.parent.parent
    if not (fw_root / "commands").is_dir():
        # Try repo root / framework
        fw_root = script_path.parent.parent.parent / "framework"
    if not (fw_root / "commands").is_dir():
        sys.stderr.write("ERROR: cannot locate framework/commands/\n")
        sys.exit(1)

    repo_root = fw_root.parent
    data_root = repo_root / "examples" / "quickstart" / "data"
    agents_md = fw_root / "AGENTS.md"
    constitution = fw_root / "CONSTITUTION.md"

    # Measure
    _, agents_tokens = read_file_tokens(agents_md)
    _, constitution_tokens = read_file_tokens(constitution)

    cmd_measurements = measure_all_commands(fw_root)
    workflow_measurements = measure_workflow(fw_root, data_root, agents_md, constitution)

    report = generate_report(cmd_measurements, workflow_measurements, agents_tokens, constitution_tokens)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report, encoding="utf-8")
        sys.stderr.write(f"Report written to {out_path}\n")
    else:
        print(report)


if __name__ == "__main__":
    main()
