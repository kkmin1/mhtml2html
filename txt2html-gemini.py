import html
import sys
from pathlib import Path


def parse_qa(text: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    question_lines: list[str] = []
    answer_lines: list[str] = []
    state: str | None = None

    def flush() -> None:
        nonlocal question_lines, answer_lines
        if question_lines or answer_lines:
            question = "\n".join(question_lines).strip("\n")
            answer = "\n".join(answer_lines).strip("\n")
            pairs.append((question, answer))
        question_lines = []
        answer_lines = []

    for line in text.splitlines():
        if line.startswith("[Turn ") and line.endswith("]"):
            flush()
            state = None
            continue
        if line.strip() == "질문:":
            state = "question"
            continue
        if line.strip() == "답변:":
            state = "answer"
            continue

        if state == "question":
            question_lines.append(line)
        elif state == "answer":
            answer_lines.append(line)

    flush()
    return pairs


def build_message(role: str, label: str, text: str) -> str:
    avatar = "U" if role == "user" else "G"
    escaped = html.escape(text)
    indent = "            "
    return (
        f"{indent}<div class=\"message {role}\">\n"
        f"{indent}    <div class=\"avatar\">{avatar}</div>\n"
        f"{indent}    <div class=\"bubble\">\n"
        f"{indent}        <div class=\"label\">{label}</div>\n"
        f"{indent}        <div class=\"text\">{escaped}</div>\n"
        f"{indent}    </div>\n"
        f"{indent}</div>"
    )


def render_html(template: str, pairs: list[tuple[str, str]]) -> str:
    start = template.find('<main class="container">')
    if start == -1:
        raise ValueError("Template missing <main class=\"container\"> tag.")
    end = template.find("</main>", start)
    if end == -1:
        raise ValueError("Template missing </main> tag.")

    prefix = template[: start + len('<main class="container">')]
    suffix = template[end:]

    blocks: list[str] = []
    for question, answer in pairs:
        blocks.append(build_message("user", "질문", question))
        blocks.append(build_message("gemini", "답변", answer))

    content = "\n\n" + "\n\n".join(blocks) + "\n\n"
    return prefix + content + suffix


def main() -> None:
    base_dir = Path(__file__).resolve().parent
    input_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else base_dir / "b.qa.txt"
    template_path = (
        Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else base_dir / "고대사 연구.html"
    )
    output_path = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else input_path.with_suffix(".html")

    qa_text = input_path.read_text(encoding="utf-8", errors="replace")
    template = template_path.read_text(encoding="utf-8", errors="replace")

    pairs = parse_qa(qa_text)
    html_text = render_html(template, pairs)

    output_path.write_text(html_text, encoding="utf-8")
    print(output_path)
    print(f"turns: {len(pairs)}")


if __name__ == "__main__":
    main()
