// The malformed-declaration shape (kernel.md, the sandbox and local-log
// sections): a tool with neither a description nor a handler. The bootstrap
// refuses the registration, names the offending field on stderr, and exits
// before `run/ready`.
return {
  tools: [
    { name: 'x' },
  ],
};
