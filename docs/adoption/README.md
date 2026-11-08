# Kalynt adoption work

Start with developers who want local inference and control over their code. Test a small, specific workflow before making broad replacement claims.

## Five first-session tests

Invite five developers who have not used Kalynt. Include different operating systems and at least one modest-memory machine. Give each person the public website, not installation instructions in advance. Ask them to:

1. Explain what Kalynt does and whether they would try it, before clicking Download.
2. Find the right installer, install it, and open a small project they are comfortable sharing on screen.
3. Choose a model connection and get an explanation of the project's entry point.
4. If their model supports tools, request one small change, inspect its diff, and run the project's tests.
5. Say what would make them return tomorrow and what their current editor does better.

Observe without steering unless they are stuck. Record the point of hesitation, their exact words, first-response time, whether the answer was useful, and whether they independently verified the result. Ask the next day whether they used Kalynt again. Do not infer retention from a download or a polite compliment.

Use anonymous participant labels. Do not record private code, API keys, server tokens, or a session video without the participant's permission.

| Participant | OS / RAM | Installed | Model ready | First useful answer | Verified task | Blocker | Returned next day |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | | | | | | | |
| P2 | | | | | | | |
| P3 | | | | | | | |
| P4 | | | | | | | |
| P5 | | | | | | | |

## Repeatable public demo

Record one real task in a small public repository. Show the repository commit, Kalynt version, OS, CPU/GPU, RAM, inference runtime, model ID/quantization, context setting, prompt, elapsed time, proposed diff, and test output. Keep pauses and failures visible. Use a task whose expected behavior can be independently verified. Publish the model's limitations alongside the successful run. A screenshot or staged transcript is not a measured agent benchmark.

Do not advertise the source-only Ollama/LM Studio connection as available in the 2.0.0 installers. Release it after packaged desktop verification. The website currently describes the installed 2.0 workflow.

## Measure without adding product telemetry

Run `node docs/adoption/snapshot.mjs` with an authenticated GitHub CLI. Save each JSON result outside this public repository if it includes owner-only traffic data.

- Repository views/clones cover GitHub's rolling window, not all website visits. Unique visitors overlap across days; do not add daily uniques into a period unique count.
- Installer counts are cumulative asset fetches, including repeats and automation. Exclude update manifests and blockmaps. Compare snapshots of the same assets; a replacement resets comparability.
- Website-to-download conversion is unknown without a separate, explicitly configured website measurement source. Do not divide GitHub unique visitors by all release downloads.
- First useful task and return use come from consenting test participants. Report the sample size and task. Five observations are qualitative evidence, not a population retention estimate.

After the five sessions, fix the most frequent blocker, rerun that path, and promote the verified workflow with its real demo. Track source and date for each launch so a later increase in interest has a plausible attribution window.
