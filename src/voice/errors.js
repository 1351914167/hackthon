"use strict";

class VoiceError extends Error {
  constructor(code, message, statusCode, options = {}) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
    this.statusCode = statusCode;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function voiceError(code, message, statusCode, options) {
  throw new VoiceError(code, message, statusCode, options);
}

module.exports = { VoiceError, voiceError };
