import React, { useState, useEffect } from 'react';
import { View, StyleSheet, StatusBar, Text } from 'react-native';
import {
  useFonts,
  Syne_700Bold,
  Syne_800ExtraBold,
} from '@expo-google-fonts/syne';
import {
  DMSans_400Regular,
  DMSans_500Medium,
} from '@expo-google-fonts/dm-sans';
import {
  SpaceMono_400Regular,
} from '@expo-google-fonts/space-mono';
import { isOnboarded } from './src/utils/storage';
import { Onboarding } from './src/screens/Onboarding';
import { SnakeGame } from './src/screens/SnakeGame';
import { VaultLogin } from './src/screens/VaultLogin';
import { Vault } from './src/screens/Vault';
import { SSBlock } from './src/components/SSBlock';
import { COLORS } from './src/utils/theme';

const ROUTES = {
  LOADING:    'loading',
  ONBOARDING: 'onboarding',
  GAME:       'game',
  LOGIN:      'login',
  VAULT:      'vault',
};

export default function App() {
  const [route, setRoute] = useState(ROUTES.LOADING);

  const [fontsLoaded, fontError] = useFonts({
    Syne_700Bold,
    Syne_800ExtraBold,
    DMSans_400Regular,
    DMSans_500Medium,
    SpaceMono_400Regular,
  });

  useEffect(() => {
    if (!fontsLoaded && !fontError) return;
    (async () => {
      const ready = await isOnboarded();
      setRoute(ready ? ROUTES.GAME : ROUTES.ONBOARDING);
    })();
  }, [fontsLoaded, fontError]);

  // Show splash while fonts load
  if (!fontsLoaded && !fontError) {
    return (
      <View style={s.splash}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />

      {route === ROUTES.LOADING && (
        <View style={s.splash} />
      )}

      {route === ROUTES.ONBOARDING && (
        <Onboarding onDone={() => setRoute(ROUTES.GAME)} />
      )}

      {route === ROUTES.GAME && (
        <SnakeGame
          onSecretGesture={() => setRoute(ROUTES.LOGIN)}
        />
      )}

      {route === ROUTES.LOGIN && (
        <VaultLogin
          onSuccess={() => setRoute(ROUTES.VAULT)}
          onBack={() => setRoute(ROUTES.GAME)}
        />
      )}

      {route === ROUTES.VAULT && (
        <>
          <Vault onLogout={() => setRoute(ROUTES.GAME)} />
          <SSBlock active={true} />
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: COLORS.bg },
  splash: { flex: 1, backgroundColor: COLORS.bg },
});
