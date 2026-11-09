# Reusable analysis layout

Use the project's current files and the task's requested interface. The following layout
is useful when several analyses or manuscript outputs need independent reruns; it is an
example rather than a required scaffold.

| Path | Purpose |
| --- | --- |
| Existing input directory | Original data, retained unchanged |
| `analysis/<name>.py` | A saved analysis or reusable stage |
| `analysis/out/` | Derived results and intermediates |
| `figures/` | Figures included in the manuscript |
| `tables/` | Table fragments included in the manuscript |

A single script is enough when it clearly loads, analyzes and writes the requested
results. Split an expensive fit from plotting when plotting has independent uses.
Keep the rerun command and relevant assumptions in the existing analysis report, script
or project guidance. Add a separate README only when it improves continued use.

## Example

```python
from collections import Counter
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    with (ROOT / "data" / "trials.csv").open(newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    counts = Counter(row["condition"] for row in rows)
    output = ROOT / "analysis" / "out" / "counts.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dict(counts), indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {output.relative_to(ROOT)} from {len(rows)} rows")


if __name__ == "__main__":
    main()
```

Choose dependencies from the method. Record filtering and missingness when they change
the analyzed sample. Stochastic work needs an explicit seed or a recorded source of
randomness; deterministic counts do not need a seed. Pin environment details when they
matter for reproduction. A content hash identifies input bytes if version tracking needs
it; it does not validate the data or require a second input manifest.

## Long work and outputs

Use `start_run` and `wait_runs` when the host offers them. Otherwise use an approved
execution method that retains the process outcome. Write large results to a file and
print a useful short summary rather than relying on truncated tool output.

Reuse an expensive intermediate only when its inputs, method and configuration still
match. An output file's existence alone does not establish that it is current. A rerun
of the requested analysis should recompute or use an identified valid cached result.

Preserve original inputs and the scripts needed for delivered results. Include generated
figures and tables that the manuscript needs to build. Avoid creating intermediates,
plan files or environment manifests that the current analysis does not use.
