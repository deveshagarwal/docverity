# VHS tape for the launch GIF: docverity reviewing its own (synthetic) stale
# README, then drafting the fixes.  vhs scripts/demo.tape  ->  docs/demo.gif
Output docs/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1760
Set Height 1240
Set Padding 22
Set Theme "Dracula"
Set WindowBar Colorful
Set TypingSpeed 50ms

# Off-camera: build the staged repo; point `docverity` at the real build, except
# `suggest` (which needs a model) replays a captured run so the GIF stays snappy.
Hide
Type 'export PS1="$ "'
Enter
Type "bash /Users/dagarwal/docverity/scripts/_demo_setup.sh"
Enter
Type "cd /tmp/docverity-demo"
Enter
Type 'docverity() { case "$1" in suggest) cat /Users/dagarwal/docverity/scripts/demo_suggest.txt;; *) node /Users/dagarwal/docverity/dist/cli.js "$@";; esac; }'
Enter
Type "clear"
Enter
Show

# Act 1: the checks, run for real against the stale docs.
Sleep 600ms
Type "# Docverity reviewing its own docs (staged stale README)"
Enter
Sleep 400ms
Type "docverity --no-llm"
Sleep 500ms
Enter
Sleep 4000ms

# Act 2: draft the missing docs.
Type "# now have it write the missing docs"
Enter
Sleep 400ms
Type "docverity suggest"
Sleep 500ms
Enter
Sleep 4500ms
