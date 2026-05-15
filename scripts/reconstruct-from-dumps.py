#!/usr/bin/env python3
"""
Reconstruct the LLM prompt for a given L1 summary from the
/tmp/llr-faith/l1/L1-N.md dumps, without needing the live chronicle.

Each L1-N.md file has:
  - SUMMARY: what opus produced for L1-N
  - SOURCE CONTENT: the chunk text that was given to opus when producing L1-N

For L1-N's prompt, the model saw (in order):
  1. Prior L1 recall pairs (L1-0 through L1-{N-1}): CM-Q + agent body
     using each prior L1's SUMMARY text
  2. Head messages (raw): we have no head for our case (L1-0 absorbed
     the chat openers), so skip
  3. Compression marker
  4. Chunk source content (raw user/assistant messages, but in our
     case all User since they're doc shards)
  5. Instruction (doc-chunk variant for bodyGroup chunks)

System prompt: as configured at the time.

Usage: python3 reconstruct-from-dumps.py <L1-N>
       python3 reconstruct-from-dumps.py L1-4
"""
import sys
import re
from pathlib import Path

DUMPS_DIR = Path("/tmp/llr-faith/l1")

COMPRESSION_MARKER = (
    "System: You will soon form a new memory, get ready. "
    "The messages that follow are the slice of recent experience you are "
    "about to compress. After them, write the memory in your own voice."
)

SYSTEM_PROMPT = (
    "You are forming autobiographical memories of an ongoing conversation. "
    "Speak in the first person from your own perspective; the messages above "
    "are your actual experience and prior recollections."
)


def doc_instruction(target_tokens=2000):
    return (
        f'You just read a slice of document "doc-bg-f81bba4dc8bef7a8" (chronological, approximately '
        f'434000 tokens total in the full document). Earlier slices '
        'of this same document are in your memory above as L1s — they are in '
        'chronological order within the document. What comes after this slice '
        'you have NOT yet read; treat yourself as reading the document in '
        'order, not yet knowing what lies ahead.\n\n'
        'Write the memory of what this slice contained. Preserve concrete '
        'detail aggressively:\n'
        '- Timestamps, dates, IDs, numeric values, quoted phrases\n'
        '- Key events, decisions, contradictions with earlier slices\n'
        '- Structural markers (section titles, entry boundaries) that help '
        'you locate this slice within the whole later\n\n'
        f'Speak in the first person. Target ~{target_tokens} tokens. Output '
        'only the memory body — no preamble, no meta-commentary about '
        'summarizing.'
    )


def parse_l1_dump(path):
    """Extract SUMMARY and SOURCE CONTENT sections from L1-N.md."""
    text = path.read_text()
    # Match ## SUMMARY through next ## or EOF
    m_sum = re.search(r"## SUMMARY[^\n]*\n+(.*?)(?=\n## SOURCE)", text, re.DOTALL)
    m_src = re.search(r"## SOURCE CONTENT[^\n]*\n+(.*)", text, re.DOTALL)
    summary = m_sum.group(1).strip() if m_sum else ""
    source = m_src.group(1).strip() if m_src else ""
    return summary, source


def main():
    if len(sys.argv) < 2:
        print("Usage: reconstruct-from-dumps.py <L1-N>")
        sys.exit(1)
    target = sys.argv[1]
    m = re.match(r"L1-(\d+)", target)
    if not m:
        print(f"Bad target: {target}")
        sys.exit(1)
    target_idx = int(m.group(1))

    # Collect all L1 dumps in order
    all_l1s = []
    for i in range(target_idx + 1):
        p = DUMPS_DIR / f"L1-{i}.md"
        if not p.exists():
            print(f"Missing dump: {p}")
            sys.exit(1)
        summary, source = parse_l1_dump(p)
        all_l1s.append((i, summary, source))

    target_summary, target_source = all_l1s[target_idx][1], all_l1s[target_idx][2]
    prior = all_l1s[:target_idx]

    # Build the prompt
    print(f"# Reconstructed prompt for L1-{target_idx}\n")
    print(f"System prompt: {SYSTEM_PROMPT}\n")
    print(f"Prior L1s shown as recall pairs: {len(prior)}")
    print(f"Chunk source content: {len(target_source)} chars (~{len(target_source)//4} tokens)\n")
    print("---\n")

    print("## MESSAGES IN PROMPT (in order):\n")

    msg_idx = 0
    for i, summary, source in prior:
        print(f"### [{msg_idx}] role=user (CM-Q for L1-{i})")
        print(f"\n[CM] Recall memory L1-{i}.\n")
        print("---")
        msg_idx += 1
        print(f"### [{msg_idx}] role=assistant (agent body of L1-{i}) — {len(summary)} chars")
        print(f"\n{summary}\n")
        print("---")
        msg_idx += 1

    # Compression marker
    print(f"### [{msg_idx}] role=user (COMPRESSION MARKER)")
    print(f"\n{COMPRESSION_MARKER}\n")
    print("---")
    msg_idx += 1

    # Chunk source
    print(f"### [{msg_idx}] role=user (CHUNK CONTENT — {len(target_source)} chars)")
    print(f"\n{target_source}\n")
    print("---")
    msg_idx += 1

    # Instruction
    print(f"### [{msg_idx}] role=user (INSTRUCTION)")
    print(f"\n{doc_instruction()}\n")
    print("---")

    print(f"\n## TOTAL: {msg_idx + 1} prompt messages\n")
    print(f"## TARGET OUTPUT (what L1-{target_idx} actually was):\n")
    print(f"{target_summary[:1500]}{'...' if len(target_summary) > 1500 else ''}")


if __name__ == "__main__":
    main()
