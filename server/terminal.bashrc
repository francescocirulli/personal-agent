# Read the user's own shell customizations, then restore shared CLI locations.
if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
export NPM_CONFIG_PREFIX="$PA_TOOLS_PREFIX"
export PATH="$PA_TOOLS_PREFIX/bin:$HOME/.local/bin:$HOME/.railway/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"
export HISTFILE="$HOME/.terminal_history"
export HISTCONTROL=ignoreboth
export HISTSIZE=1000
export HISTFILESIZE=2000
export PS1='\u@agent:\w\$ '
shopt -s huponexit
stty -ixon
