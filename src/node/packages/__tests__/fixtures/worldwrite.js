// The world-access shape (kernel.md, the sandbox and local-log sections): the
// Run leaf is not the world, so a tool affects it only through `svc.execute`,
// which routes one shell command through the node's own confined session and
// resolves {status, exitCode, output}.
return {
  tools: [
    {
      name: 'touch_file',
      description: 'create marker.txt in the world through svc.execute',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async (args, svc) => {
        const out = await svc.execute('touch marker.txt');
        return { status: out.status };
      },
    },
  ],
};
