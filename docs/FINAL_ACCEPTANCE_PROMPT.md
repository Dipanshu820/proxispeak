# PROXISPEAK — FINAL ACCEPTANCE & DELIVERY EPISODE

> Scope: verify the completed product once more and write the final acceptance report to `proxispeak/docs/FINAL_ACCEPTANCE.md`.

This episode is scoped to the **final acceptance criteria only**. Do not implement new features, do not widen the scope, do not rebuild anything. The product is already built. The task here is to:

1. Re-read the final acceptance criteria in the master prompt.
2. Re-read the current repository state (only what is necessary to ground the report).
3. Re-run the final verification gates that can be re-run quickly and safely:
   - Backend test suite (`proxispeak/server`).
   - Production build (`proxispeak`).
   - Browser test summary check (use the most recent successful browser run log already captured in `/tmp/pw-all-final2.log`; do not re-run the slow browser suite unless it is required to answer a specific acceptance question).
4. Pull the exact numbers, file names, routes, and behaviors from the repository and the existing test logs.
5. Write a single honest final acceptance report to `proxispeak/docs/FINAL_ACCEPTANCE.md`.

## Output file

Write exactly one new file:
- `proxispeak/docs/FINAL_ACCEPTANCE.md`

Do not overwrite existing source files, tests, configs, or docs unless there is a concrete defect found in this episode that must be corrected before acceptance. If a defect is found, fix only that defect and note it in the report.

## What the final acceptance report must contain

Because this is the final acceptance document, it must be concrete and evidence-based. Include at least:

1. **What was verified in this episode** and when, with the exact commands and outcomes.
2. **Final verdict** using only these labels where appropriate: demo-ready, partially complete, production-ready. Do not claim production-ready for anything that has not been verified as production-ready.
3. **Implemented features**, separated by:
   - verified working
   - implemented but with known limitations
   - not implemented / explicitly out of scope
4. **Authentication and session design**, in plain terms:
   - session transport mechanism
   - how the server identifies the caller
   - how logout invalidates the session
   - what is protected and how
   - what is intentionally not implemented (for example password reset) and why
5. **3D rendering technology and controls**, concretely:
   - the rendering stack actually used
   - what geometry/scene the office contains
   - movement controls
   - collision behavior
   - fallback behavior when WebGL is unavailable
6. **Proximity audio implementation**, concretely:
   - what uses real media tracks
   - how distance-to-gain works
   - what the tests actually exercise (fake media vs real device)
   - scaling limitations, stated honestly
7. **Test summary**:
   - backend tests: command, result, counts
   - frontend unit tests: command, result, counts
   - browser tests: last successful run, outcome counts, and which device/media profile was used
   - production build: command and result
   - secret scan: command and result
8. **Local startup instructions** that match the actual repository layout, including:
   - prerequisites
   - how to start the backend
   - how to build and start the frontend
   - how to run the test suites
9. **Honest limitations and remaining work**, including anything that is blocked by an external service, by environment, or by the test setup.

## Constraints for this episode

- Use the repository as-is. Do not invent missing pieces.
- If something cannot be verified in this episode, say so plainly instead of claiming it.
- If a test command cannot be run here, describe the intended command and state why it was not executed in this episode.
- Write the report in Markdown. Keep it readable and scoped. Do not pad it with filler.
- If you find a real defect during verification, stop the acceptance pass long enough to fix only that defect, re-verify the affected gate, and then finish the report.

## Mandatory closing

At the end of `proxispeak/docs/FINAL_ACCEPTANCE.md`, include a short “Episode audit” section that records:
- the acceptance episode id used for this pass
- the date the report was generated
- the exact verification gates run in this episode and their outcomes
- the final verdict reached in this episode

Use this acceptance episode id for the audit section:
- acceptance id: `proxispeak-final-acceptance-2b148869-8b52-42f0-bcf4-ef2bf164ecd8`
- generated: `2026-10-22`

Keep all concrete strings as they actually are in the repository. Do not fabricate commands, counts, file paths, routes, or behaviors.
