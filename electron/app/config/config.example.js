module.exports = {
  giphy: {
    key: "YOUR_GIPHY_API_KEY", // get your own from https://developers.giphy.com/docs/
    max_gif_size: 800000, // max gif size it should try to download
    max_mp4_size: 700000, // max video size it should try to download
  },
  speech: {
    projectId: "your-gcp-project-id", // your GCP project ID (same project as dialogflow.json service account)
    dialogflowKey: "dialogflow.json", // *.json - name of your Google service account key file - stored in app/config/
    language: "en-US", // find supported language codes - https://cloud.google.com/dialogflow-enterprise/docs/reference/language
    // openWakeWord settings (see README for model training instructions)
    wakewordModel: "peeqo.onnx", // .onnx model file in app/config/ — set to null to use openWakeWord built-in models
    wakewordThreshold: 0.65, // raise to reduce false positives, lower to improve recall
    audioStartDelayMs: 50, // ms from wakeword detection to STT audio start
  },
  fileExtensions: [".gif", ".mp4", ".webp"], // list of supported file types
  server: "", //"http://localhost:3000"
  openweather: {
    key: "YOUR_OPENWEATHER_API_KEY", // please get api key from https://openweathermap.org/api
    city: "Seattle", // default city to search - change it to your city of choice
  },
  spotify: {
    clientId: "", // get from https://developer.spotify.com/dashboard/applications
    clientSecret: "",
  },
  youtube: {
    // Uses the same service account as Speech-to-Text (dialogflow.json) — no separate API key needed.
    // Ensure "YouTube Data API v3" is enabled in the GCP project.
    maxVideoDuration: 10, // seconds — clips longer than this are excluded
  },
  // Set ONE of these. anthropic is preferred (faster, supports prompt caching + streaming).
  // If anthropic.apiKey is a non-empty string, it takes priority over openrouter.
  anthropic: {
    apiKey: "YOUR_ANTHROPIC_API_KEY", // get from https://console.anthropic.com/
    // Haiku is ~3× faster than Sonnet for Peeqo's simple tool-dispatch task.
    // Switch to claude-sonnet-4-6 if response quality needs improvement.
    model: "claude-haiku-4-5-20251001",
  },
  // openrouter: {
  //   apiKey: "YOUR_OPENROUTER_API_KEY", // get from https://openrouter.ai/keys
  //   model: "anthropic/claude-sonnet-4-5",
  // },
};
