// One registered tool calling the web facade — the search form with its
// optional bound. Plain JavaScript, no imports: the kernel channel is svc.
return {
  tools: [{
    name: 'find_docs',
    description: 'search the web through the node',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
    },
    handler: async (args, svc) => {
      const out = await svc.web_search(args.query, 5);
      return { found: out.body.length > 0 };
    },
  }],
};
