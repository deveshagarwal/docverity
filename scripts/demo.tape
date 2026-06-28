# VHS tape for the launch GIF. Records the real docverity CLI in a real terminal.
#   vhs scripts/demo.tape   ->   docs/demo.gif
Output docs/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1560
Set Height 600
Set Padding 22
Set Theme "Dracula"
Set WindowBar Colorful
Set TypingSpeed 55ms

# Setup, off-camera: build the drifted demo repo and a clean prompt.
Hide
Type 'export PS1="$ "'
Enter
Type "bash /Users/dagarwal/docverity/scripts/_demo_setup.sh"
Enter
Type "cd /tmp/taskwarden-demo"
Enter
Type 'docverity() { node /Users/dagarwal/docverity/dist/cli.js "$@"; }'
Enter
Type "clear"
Enter
Show

# On-camera: run the real tool against the drifted docs.
Sleep 800ms
Type "docverity --no-llm"
Sleep 600ms
Enter
Sleep 4500ms
