// plugins/withFlagSecure.js
// Expo config plugin that adds FLAG_SECURE to MainActivity
// This blocks screenshots and screen recording on Android at OS level.
//
// Usage: add to app.json plugins array:
//   "plugins": [["./plugins/withFlagSecure"]]

const { withMainActivity } = require('@expo/config-plugins');

module.exports = function withFlagSecure(config) {
  return withMainActivity(config, (config) => {
    const src = config.modResults.contents;

    // Add import if not present
    if (!src.includes('import android.view.WindowManager')) {
      config.modResults.contents = src.replace(
        'import com.facebook.react.ReactActivity;',
        'import android.view.WindowManager;\nimport com.facebook.react.ReactActivity;'
      );
    }

    // Add FLAG_SECURE in onCreate after super.onCreate
    if (!src.includes('FLAG_SECURE')) {
      config.modResults.contents = config.modResults.contents.replace(
        'super.onCreate(savedInstanceState);',
        `super.onCreate(savedInstanceState);
    getWindow().setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE
    );`
      );
    }

    return config;
  });
};
