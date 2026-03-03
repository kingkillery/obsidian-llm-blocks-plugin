---
tags:
  - ai
  - video
  - remotion
  - agents
cssclass: reference
pinned: true
---
# AI Video Agent Tooling Research Guide (Obsidian-ready)

## Scope
A consolidated playbook for building AI-generated educational videos with code-first pipelines.

## Core stack (recommended defaults)

- **Programmatic animation engine:** [Remotion](https://www.remotion.dev/)
	- Primary docs:
		- [Recorder](https://www.remotion.dev/docs/recorder)
		- [API](https://www.remotion.dev/docs/api)
		- [AI MCP](https://www.remotion.dev/docs/ai/mcp)
- **Alternative TS runtime:** [Revideo](https://github.com/videosdk-live/agents)
- **Agent infra / SDKs:** [ai-sdk.dev](https://ai-sdk.dev/)
- **Vision + multimodal agent patterns:** [GetStream Vision Agents](https://github.com/GetStream/Vision-Agents)

## Model providers for visual generation

- **Text-to-video / animation generators**
	- [Runway (Gen-3)](https://app.runwayml.com/) (free trial available)
	- Luma Dream Machine
	- KomikoAI Inbetweenin
	- [Replicate](https://replicate.com/) ($5 starter credit)
		- [WAN 2.2 I2V Fast](https://replicate.com/wan-video/wan-2.2-i2v-fast)
		- [DreamActor M2.0](https://replicate.com/bytedance/dreamactor-m2.0)
- **Images / storyboards / transition plates**
	- `openai/gpt-image-1.5`
	- [Google Nano Banana Pro](https://replicate.com/google/nano-banana-pro)
	- [PRUNA AI Z-image Turbo](https://replicate.com/prunaai/z-image-turbo)

## Music stack

- [ACE-Step v1.5](https://ace-step.github.io/ace-step-v1.5.github.io/)
- [HeartMuLa Heartlib](https://github.com/HeartMuLa/heartlib)
- [HeartMuLa OSS 3B](https://huggingface.co/HeartMuLa/HeartMuLa-oss-3B)
- [NVIDIA Music Flamingo](https://huggingface.co/nvidia/music-flamingo-think-2601-hf)

## Deep Research synthesis (from repeated drafts)

For programmatic motion pipelines:

- **Remotion** is strongest for deterministic, React-based sequencing, keyframes, tweens, and scene composition; it integrates well with AI codegen and supports MP4/GIF export.
- **Revideo** provides a TypeScript-oriented alternative with similar scene/animation composition if you want less React coupling.
- Python-focused libraries (e.g., keyframed) can generate math-based interpolation curves and can be used upstream of Remotion.
- For quick editing/asset prep outside JS, JS or Python tooling can supplement (headless editors, batch pipelines).

## Agent integration pattern (practical)

1. **Generate storyboard + timeline plan** (text/script in structured JSON/markdown).
2. **Generate visuals**
	- Text-to-image for frames and transitions.
	- Text-to-video for motion-heavy clips.
3. **Build deterministic video assembly**
	- Use Remotion/Revideo to lay out scenes with fixed durations, easing, and transitions.
4. **AI-assisted refinement pass**
	- Route selected frames/clips to enhancement models (e.g., Runway/Luma/Replicate) as needed.
5. **Export + finalize**
	- Render via CLI pipelines and archive final artifacts + logs.

## Minimal recommendation

- Default stack for scale + reproducibility:
	1. **Remotion** for final authoring/render
	2. **Replicate** for generative media
	3. `openai/gpt-image-1.5` or **Nano Banana Pro** for static assets
	4. **ACE-Step** for music cues
- Keep heavy visual model output and deterministic render logic separated so you can replay/iterate quickly.

## Notes

- You shared plugin workspace path for reference:  
	`C:\Users\prest\OneDrive\Desktop\Desktop-Projects\Helpful-Docs-Prompts\Obsidian Vault\.obsidian\plugins\llm-blocks`

