"use strict";

const { VoiceError } = require("./errors");
const {
  ALLOWED_VOICES,
  LINGXI_BASE_URL,
  SPEECH_MODEL,
  TRANSCRIPTION_MODEL,
  createLingxiGateway,
} = require("./lingxi-gateway");
const { createVoiceSegmentStore } = require("./segment-store");

module.exports = {
  ALLOWED_VOICES,
  LINGXI_BASE_URL,
  SPEECH_MODEL,
  TRANSCRIPTION_MODEL,
  VoiceError,
  createLingxiGateway,
  createVoiceSegmentStore,
};
