// The throwing-handler shape (kernel.md, the sandbox and local-log sections): a
// thrown handler value becomes a bounded `ok: false` tool/result; the Run stays
// alive and serves the next invoke.
return {
  tools: [
    {
      name: 'explode',
      description: 'always throws',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        throw new Error('boom');
      },
    },
  ],
};
