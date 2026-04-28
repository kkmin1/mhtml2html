# mhtml2html

MHTML을 HTML, Markdown, 텍스트로 변환하기 위한 작업 저장소입니다.

## 개요

이 저장소는 MHTML 변환을 여러 방식으로 실험하는 워크벤치입니다. Python 스크립트, HTML 테스트 파일, 그리고 일부 Electron 실행 파일이 함께 있어 변환 결과를 비교하거나 UI에서 실행해 볼 수 있습니다.

주요 파일:
- `mhtml_to_html_general.py`: 일반 MHTML -> HTML 변환 실험
- `mhtml2html-gemini.py`, `mhtml2html-gpt.py`, `mhtml2html-grok.py`: 플랫폼별 처리 실험
- `mhtml_to_md-general.py`, `mhtml2md_glm.py`, `mhtml2md-grok.py`: Markdown 변환 계열
- `mhtml2txt-chatgpt.py`, `mhtml2txt-gemini.py`: 텍스트 추출 계열
- `index.html`: 실행/테스트용 진입점

## 실행 방법

Python 스크립트를 직접 실행하거나, HTML 파일을 브라우저에서 열어 결과를 확인할 수 있습니다.

예시:

```bash
python mhtml_to_html_general.py
python mhtml2html-gemini.py
```

## 용도

- MHTML 변환 알고리즘 비교
- LLM별 저장 형식 차이 대응
- HTML/Markdown/TXT 전처리 실험
