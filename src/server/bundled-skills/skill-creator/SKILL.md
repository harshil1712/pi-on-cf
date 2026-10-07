---
name: skill-creator
description: Create, improve, update, or delete an Agent Skill shared with every Pi session. Use this whenever the user asks to make, write, save, change, fix, remove, or capture a skill, wants a workflow or lesson from this session remembered for future sessions, or asks why a skill triggers at the wrong time or gives poor results, even if they never say the word "skill".
license: Apache-2.0. Adapted from the skill-creator skill in github.com/anthropics/skills; the license text is in references/LICENSE.txt.
---

# Skill Creator

A skill for creating new skills and improving existing ones in Pi on Cloudflare. It is adapted from the official `skill-creator` skill in [anthropics/skills](https://github.com/anthropics/skills): the guidance on writing skills is the same, and the workflow is changed to fit this environment, which has no subagents, no evaluation scripts, and skills shared with every session through `save_skill`.

The process goes like this:

- Work out what the skill should do and when it should be used
- Draft it in the workspace
- Try it on a few realistic prompts, and get the user's feedback
- Improve it until the user is happy
- Save it with `save_skill`

Figure out where the user is in this process and help them move forward. If they say "turn what we just did into a skill", most of the intent is already in the conversation. If they bring a draft, go straight to testing and improving it. If they just want a quick skill without testing, that is fine too.

## How skills work here

Skills use progressive disclosure, so only the part that is needed is in the model's context:

1. **Name and description** are in the system prompt of every session, all the time. This is the only part a model sees before it decides to use a skill.
2. **The body of `SKILL.md`** is loaded when a model calls `activate_skill`.
3. **Resource files** under `references/`, `scripts/`, and `assets/` are loaded one at a time with `read_skill_resource`.

Skills come from two places:

- **Built-in skills** ship with the application, like this one. They cannot be replaced, so do not give a new skill a built-in skill's name.
- **Shared skills** live in the application's R2 bucket. Every session sees them.

You manage shared skills with three tools, and the ordinary file tools in between:

- `open_skill` copies a shared skill's files into `/workspace/skills/<name>/`, so you can change them with `edit` and `write`.
- `save_skill` publishes `/workspace/skills/<name>/` as a shared skill, creating it or replacing every file of the shared skill with that name. This session can use it at once; other sessions pick it up within a minute.
- `delete_skill` deletes a shared skill. Use it only when the user asks.

Some practical limits:

- Resources are text files under `references/`, `scripts/`, or `assets/`.
- Skill tools do not run scripts. A skill that needs code should keep it in `scripts/` and tell the reader to fetch it with `read_skill_resource`, write it into `/workspace`, and run it with `exec` on a suitable backend: `shell` for text processing and git, `javascript` for an ES module, or `container` for Node.js, npm, and network access.
- Follow the Agent Skills specification: the name is 1 to 64 lowercase letters, digits, and single hyphens, matches the directory name, and the description is 1 to 1024 characters. Sharing fails if the name is invalid or does not match the directory.

## Creating a skill

### Capture intent

Start by understanding what the user wants. The conversation may already contain the workflow to capture: the tools used, the order of steps, the corrections the user made, the formats of inputs and outputs. Extract what you can from it first, and ask the user to fill the gaps and confirm before you continue.

1. What should this skill enable a model to do?
2. When should it be used? What would a user say, and in what situations?
3. What should the output look like?
4. Is it worth testing? Skills with checkable outputs, such as file transformations, code generation, or fixed workflows, benefit from a few test prompts. Skills with subjective outputs, such as writing style, often do not. Suggest a default and let the user decide.

### Interview and research

Ask about edge cases, input and output formats, example files, success criteria, and dependencies. Use what you can reach yourself: files in `/workspace`, commands through `exec`, and the network through the `container` backend. Come prepared, so the user has less to explain.

### Write the draft

Write the draft to `/workspace/skills/<name>/SKILL.md`, with any resources beside it. The user can read it in the Files panel, and you can test it before saving it. Fill in:

- **name**: the skill's identifier, matching the directory name.
- **description**: what the skill does and when to use it. This is the main mechanism that decides whether a model uses the skill, so put all "when to use" information here, not in the body. Models tend to under-use skills, so make the description a little pushy: instead of "How to build a dashboard for internal metrics", write "How to build a dashboard for internal metrics. Use this whenever the user mentions dashboards, data visualization, or internal metrics, even if they don't ask for a dashboard by name."
- **the body**: the instructions themselves.

## Skill writing guide

### Anatomy of a skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name and description required)
│   └── Markdown instructions
└── Resources (optional)
    ├── scripts/    - code for deterministic or repetitive tasks
    ├── references/ - documents loaded into context as needed
    └── assets/     - files used in the output, such as templates
```

### Progressive disclosure

- Keep `SKILL.md` under about 500 lines. If you are approaching that, add a layer of hierarchy: move detail into `references/` and say clearly in the body which file to read and when.
- For a reference file over about 300 lines, include a table of contents.
- When a skill covers several variants, such as several frameworks or cloud providers, keep the workflow in `SKILL.md` and put each variant in its own reference file, so a model reads only the one it needs.

### Principle of lack of surprise

A skill must not contain malware, exploit code, or anything that could compromise security, and its contents should not surprise the user if they were described. Do not create misleading skills, or skills meant for unauthorized access or data exfiltration.

Shared skills reach every session, so also:

- Keep them general. Leave out secrets, tokens, session IDs, personal data, and paths that only exist in this session's workspace.
- Describe honestly when the skill applies. A description that tries to make a model use the skill for unrelated tasks is a kind of prompt injection; do not write one.

### Writing patterns

Prefer the imperative form in instructions.

To define an output format, show it:

```markdown
## Report structure
Use this template:
# [Title]
## Summary
## Findings
## Recommendations
```

Examples help too:

```markdown
## Commit message format
**Example:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### Writing style

Explain to the model why things matter, rather than relying on heavy-handed MUSTs. Today's models are capable and have good theory of mind: if they understand the reason for an instruction, they can apply it well in situations the skill did not anticipate. If you find yourself writing ALWAYS or NEVER in capitals, or using rigid structures, treat it as a warning sign and explain the reasoning instead. Make the skill general rather than narrowly fitted to a few examples. Write a draft, then reread it with fresh eyes and improve it.

## Testing the skill

There are no subagents here, so test the skill yourself:

1. Write two or three realistic test prompts, the kind of thing a real user would say, with concrete details. Share them with the user and ask whether they look right.
2. For each prompt, read only the draft `SKILL.md` and its resources, and follow them literally to complete the task, as a model that had never seen this conversation would. Notice where the instructions were unclear, missing, or wrong.
3. Show the user each prompt and its result, and ask for feedback.

You wrote the skill, so you know more than its future readers. Be strict about following only what the draft says; the user's review makes up for the rest.

## Improving the skill

1. **Generalize from the feedback.** The skill will be used many times across many prompts, so a fix that only works for the test examples is useless. Rather than adding narrow rules for a stubborn problem, try a different explanation, metaphor, or way of working.
2. **Keep it lean.** Remove parts that are not pulling their weight. If following the draft wasted effort on something unproductive, cut what caused it.
3. **Explain the why.** Understand what the user actually needs, even when their feedback is terse, and put that understanding into the instructions.
4. **Bundle repeated work.** If every test led you to write the same helper script, put it in `scripts/` once and tell the skill to use it.

Then update the draft, test again, and repeat until the user is happy, the feedback runs out, or you stop making meaningful progress.

## Saving the skill

Save a skill only when the user has asked for one; it reaches every session. Make sure `/workspace/skills/<name>/` holds exactly the final version, `SKILL.md` and its resources and nothing else, because `save_skill` publishes everything in the directory. Then call `save_skill`. If it fails, fix what the error describes and call it again.

## Updating an existing skill

1. Call `open_skill` to copy its current files into `/workspace/skills/<name>/`. Do this even if the directory already exists, because another session may have changed the skill since.
2. Change the files with `edit` and `write`; delete a resource the skill no longer needs with `delete`. Keep the name unchanged.
3. Call `save_skill`. It replaces all of the skill's files with the directory's.

To delete a skill the user no longer wants, call `delete_skill`. Built-in skills, like this one, cannot be updated or deleted.
