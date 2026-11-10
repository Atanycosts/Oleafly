# Tooling notes

Facts about how Oleafly runs tools that change what a good procedure looks like. Consult the details relevant to the current operation.

## Approval

Every tool call is classified read, write, network or shell.

- Read tools (`read_file`, `list_files`, `search_project`, `project_map`, `get_todos`, `list_notes`, `project_library_search`, `load_skill`, `read_skill_file`) run without prompting under the default policy.
- Network tools (`literature_search`, `read_paper`, `verify_citation`, `alphaxiv_search`, `alphaxiv_paper_content`) are auto approved under the default policy and prompt under the stricter one. `literature_search` searches every scholarly index in one call; `read_paper` exists in research tasks only.
- In a research task, commands and runs follow the task's brief instead of approval cards: allowed, asked one at a time in the task's approval queue, or off. Long work belongs in `start_run`, which keeps running after the tool call returns; `wait_runs` returns when a run finishes.
- Write tools (`write_file`, `replace_in_file`, `create_file`, `rename_file`, `delete_file`) show a diff card the user has to approve, except in Full access. A project allow rule skips the card only when the project uses Custom mode.
- `run_command` is shell class. Each call shows a command card in the chat that the user has to approve, except in Full access. A project allow rule skips the card only when the project uses Custom mode.
- A project deny rule refuses its tool in every approval mode, Full access included. The call comes back declined or as an error. Treat it like the user saying no.

A declined call comes back as `{"declined": true, "status": "declined"}`. That is the user saying no. Do not retry the same call, and do not route around it with a different tool. Ask what they would prefer instead.

In approval modes that prompt for shell calls, batching related work can reduce repeated command cards.

## run_command

- One shell line, run through the login shell from the project root.
- 120 second timeout. Over that, the process tree is killed and the result has `timed_out: true`.
- 200 KiB combined stdout and stderr cap. Over that, the result has `truncated: true` and you have lost the tail.
- No filesystem or network sandbox beyond the approval gate. It can do anything the user can.
- On Windows it is `cmd /C`, not a login shell, so PATH additions made by a shell profile are not visible.

Two consequences. Long or chatty scripts should write to a file under `research/` and be read back with `read_file`. And never assume a tool exists because it exists on your machine: check with `command -v <tool>` inside the same command, or accept the failure gracefully.

## Vendored skill scripts

Vendored skills ship Python under `<skill dir>/scripts/`. The scripts are not in the project, so relative paths do not reach them. `load_skill` returns the absolute directory. Quote it.

```
python3 "<skill dir>/scripts/validate_citations.py" references.bib --report research/bib-report.json
```

Requirements vary by skill and are stated in each skill's `compatibility` line. `paper-lookup` and `scientific-writing` use only the Python standard library. `citation-management` needs `requests`, and its Google Scholar path additionally needs `scholarly`. Check the frontmatter that `load_skill` returned before assuming a script will import cleanly, and prefer the standard library ones when either would do.

If a script needs a missing module, use an available equivalent method or obtain any permission needed to install it. Preserve the requested operation and explain an unavailable capability when it affects delivery.

## Delegation

Use the current host's schema. Ordinary chat offers asynchronous `spawn_agent`,
`wait_agent` and `close_agent`. A ResearchTask's `spawn_agent` instead accepts a bounded
`brief`, optional `paths` and `max_minutes`, runs a reading helper and returns its result
in that call. It permits at most three concurrent helpers. Helpers can read project files,
read paper windows, verify citation identities and read known task PDF references. They
write only inside the task record and cannot run commands or spawn further helpers.

Persistent task-group members use the group's messaging and work tools. Their independent
executions, waiting and shared budget are owned by the runtime. Do not call ordinary-chat
agent wait/close tools when they are absent from the task's catalogue.

## Compile

Use the actual compile result schema. Ordinary chat persists the active editor file and
builds the project. A ResearchTask builds its isolated workspace and returns `ok`,
diagnostics and, for a fresh successful output, a complete retained `artifact`. A compile
status alone is not a claim check or visual verification.

Compile changes that affect the document build, using the diagnostics to identify and repair failures.

In a ResearchTask, pass the complete compile `artifact` as `reference` to `task_pdf_text`.
It returns bounded `text`, `nextOffset` and an exact source locator. Continue with
`offset: nextOffset` until the affected passages have been read. `task_pdf_pages` renders
selected pages when offered. Captured generation 0 inputs and newly compiled PDFs are
separate artifacts. In ordinary chat, use `get_pdf_text` and the offered preview tools.
Inspect actual passages and citations rather than assuming a successful build is correct.

## Notes and todos

`update_todos` replaces the whole checklist, so send it in full. In a ResearchTask,
`remember_note` accepts `text` and appends a dated note to the existing task record.
Ordinary chat has its own note schema and may expose `forget_note`. Use offered tools
rather than assuming notes have IDs or are injected into every request.
