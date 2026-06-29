# VHS tape for the launch GIF. Records the real docverity CLI on a real famous
# repo (oclif).  vhs scripts/demo.tape  ->  docs/demo.gif
Output docs/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1680
Set Height 1120
Set Padding 22
Set Theme "Dracula"
Set WindowBar Colorful
Set TypingSpeed 55ms

# Setup, off-camera: clone the repo, point `docverity` at the local build.
Hide
Type 'export PS1="$ "'
Enter
Type "bash /Users/dagarwal/docverity/scripts/_demo_setup.sh"
Enter
Type "cd /tmp/docverity-demo-oclif"
Enter
Type 'docverity() { node /Users/dagarwal/docverity/dist/cli.js "$@"; }'
Enter
Type "clear"
Enter
Show

# On-camera: run the real tool against oclif's docs.
Sleep 700ms
Type "# oclif (the Node CLI framework): which env vars does the code read that the docs never mention?"
Enter
Sleep 500ms
Type "docverity --no-llm"
Sleep 600ms
Enter
Sleep 4800ms
