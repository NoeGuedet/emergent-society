// One registered tool: the minimal authoring shape with a strict schema —
// the funnel-validation fixture (a required string with a length floor and
// additionalProperties refused). Plain JavaScript, no imports.
return {
  tools: [{
    name: 'echo_text',
    description: 'echoes the text',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async (args) => ({ echoed: args.text }),
  }],
};
