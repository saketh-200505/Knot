import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Dimensions,
  PanResponder, Animated, Platform,
} from 'react-native';
import { getGesture } from '../utils/storage';
import { COLORS, FONTS, SPACING, RADIUS } from '../utils/theme';

const { width: SW } = Dimensions.get('window');
const GRID = 20;
const CELL = Math.floor((SW - 32) / GRID);
const BOARD = CELL * GRID;
const TICK  = 150;

const dirs = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
const OPPOSITES = { up:'down', down:'up', left:'right', right:'left' };

function randomCell(snake) {
  let p;
  do {
    p = [
      Math.floor(Math.random() * GRID),
      Math.floor(Math.random() * GRID),
    ];
  } while (snake.some(s => s[0] === p[0] && s[1] === p[1]));
  return p;
}

export function SnakeGame({ onSecretGesture }) {
  const [snake, setSnake]     = useState([[10,10],[9,10],[8,10]]);
  const [food, setFood]       = useState([15, 8]);
  const [score, setScore]     = useState(0);
  const [hiScore, setHiScore] = useState(0);
  const [running, setRunning] = useState(false);
  const [dead, setDead]       = useState(false);
  const [level, setLevel]     = useState(1);

  const dirRef       = useRef('right');
  const snakeRef     = useRef([[10,10],[9,10],[8,10]]);
  const foodRef      = useRef([15, 8]);
  const scoreRef     = useRef(0);
  const tickRef      = useRef(TICK);
  const loopRef      = useRef(null);
  const runningRef   = useRef(false);

  // Gesture state — completely independent of game direction
  const gestureSeq    = useRef([]);
  const secretGesture = useRef(['up','up','down','down']);
  const onGestureRef  = useRef(onSecretGesture);
  onGestureRef.current = onSecretGesture;

  const flashAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    getGesture().then(g => {
      secretGesture.current = g;
      console.log('Secret gesture loaded:', g);
    });
  }, []);

  // ── Core gesture recorder — called on EVERY button tap, independent of game ──
  const recordGesture = useCallback((d) => {
    const seq = [...gestureSeq.current, d].slice(-10);
    gestureSeq.current = seq;
    const secret = secretGesture.current;
    if (seq.length >= secret.length) {
      const tail = seq.slice(-secret.length);
      const match = tail.every((v, i) => v === secret[i]);
      if (match) {
        console.log('SECRET GESTURE MATCHED');
        gestureSeq.current = [];
        onGestureRef.current?.();
      }
    }
  }, []);

  // ── Snake direction — only changes direction, never blocks gesture recording ──
  const changeSnakeDir = useCallback((d) => {
    if (!runningRef.current) return;
    if (OPPOSITES[d] === dirRef.current) return;
    dirRef.current = d;
  }, []);

  // ── Unified handler: record gesture first, then steer snake ──
  const handleInput = useCallback((d) => {
    recordGesture(d);
    changeSnakeDir(d);
  }, [recordGesture, changeSnakeDir]);

  const flashScore = useCallback(() => {
    Animated.sequence([
      Animated.timing(flashAnim, { toValue: 1, duration: 80, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start();
  }, [flashAnim]);

  const tick = useCallback(() => {
    const [dx, dy] = dirs[dirRef.current];
    const head = snakeRef.current[0];
    const newHead = [head[0] + dx, head[1] + dy];

    if (newHead[0] < 0 || newHead[0] >= GRID || newHead[1] < 0 || newHead[1] >= GRID) {
      runningRef.current = false;
      setDead(true); setRunning(false); clearInterval(loopRef.current);
      return;
    }
    if (snakeRef.current.some(s => s[0] === newHead[0] && s[1] === newHead[1])) {
      runningRef.current = false;
      setDead(true); setRunning(false); clearInterval(loopRef.current);
      return;
    }

    let newSnake = [newHead, ...snakeRef.current];
    let newFood  = foodRef.current;

    if (newHead[0] === newFood[0] && newHead[1] === newFood[1]) {
      const ns = scoreRef.current + 10;
      scoreRef.current = ns;
      setScore(ns);
      setHiScore(h => Math.max(h, ns));
      flashScore();
      newFood = randomCell(newSnake);
      foodRef.current = newFood;
      setFood([...newFood]);
      const newLevel = Math.floor(ns / 50) + 1;
      setLevel(newLevel);
      tickRef.current = Math.max(60, TICK - (newLevel - 1) * 15);
      clearInterval(loopRef.current);
      loopRef.current = setInterval(tick, tickRef.current);
    } else {
      newSnake.pop();
    }

    snakeRef.current = newSnake;
    setSnake([...newSnake]);
  }, [flashScore]);

  const startGame = useCallback(() => {
    const init = [[10,10],[9,10],[8,10]];
    snakeRef.current  = init;
    dirRef.current    = 'right';
    scoreRef.current  = 0;
    foodRef.current   = [15, 8];
    tickRef.current   = TICK;
    runningRef.current = true;
    setSnake(init);
    setFood([15, 8]);
    setScore(0);
    setDead(false);
    setLevel(1);
    setRunning(true);
    clearInterval(loopRef.current);
    loopRef.current = setInterval(tick, tickRef.current);
  }, [tick]);

  useEffect(() => {
    return () => clearInterval(loopRef.current);
  }, []);

  // Keyboard controls (web)
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e) => {
      const map = {
        ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
        w:'up', s:'down', a:'left', d:'right',
      };
      const d = map[e.key];
      if (d) { e.preventDefault(); handleInput(d); }
      if (e.key === ' ') { if (!runningRef.current) startGame(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleInput, startGame]);

  // Swipe controls
  const handleInputRef = useRef(handleInput);
  handleInputRef.current = handleInput;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderRelease: (_, g) => {
        const { dx, dy } = g;
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; // ignore taps
        if (Math.abs(dx) > Math.abs(dy)) {
          handleInputRef.current(dx > 0 ? 'right' : 'left');
        } else {
          handleInputRef.current(dy > 0 ? 'down' : 'up');
        }
      },
    })
  ).current;

  const flashColor = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [COLORS.green, '#ffffff'],
  });

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.scoreBox}>
          <Text style={s.scoreLabel}>SCORE</Text>
          <Animated.Text style={[s.scoreVal, { color: flashColor }]}>
            {String(score).padStart(5, '0')}
          </Animated.Text>
        </View>
        <Text style={s.titleTxt}>SNAKE</Text>
        <View style={s.scoreBox}>
          <Text style={s.scoreLabel}>BEST</Text>
          <Text style={[s.scoreVal, { color: COLORS.amber }]}>
            {String(hiScore).padStart(5, '0')}
          </Text>
        </View>
      </View>

      <View style={s.levelRow}>
        <Text style={s.levelTxt}>LVL {level}</Text>
        <View style={s.levelDots}>
          {Array.from({ length: Math.min(level, 10) }).map((_, i) => (
            <View key={i} style={s.lvlDot} />
          ))}
        </View>
      </View>

      {/* Game board */}
      <View style={s.boardWrap} {...panResponder.panHandlers}>
        <View style={[s.board, { width: BOARD, height: BOARD }]}>
          {Array.from({ length: GRID + 1 }).map((_, i) => (
            <View key={`h${i}`} style={[s.gridH, { top: i * CELL }]} />
          ))}
          {Array.from({ length: GRID + 1 }).map((_, i) => (
            <View key={`v${i}`} style={[s.gridV, { left: i * CELL }]} />
          ))}

          {snake.map((seg, i) => (
            <View
              key={i}
              style={[
                s.seg,
                {
                  left: seg[0] * CELL + 1,
                  top:  seg[1] * CELL + 1,
                  width:  CELL - 2,
                  height: CELL - 2,
                  backgroundColor: i === 0 ? COLORS.snakeHead : COLORS.snakeBody,
                  borderRadius: i === 0 ? 4 : 2,
                  zIndex: snake.length - i,
                },
              ]}
            >
              {i === 0 && (
                <>
                  <View style={[s.eye, s.eyeL]} />
                  <View style={[s.eye, s.eyeR]} />
                </>
              )}
            </View>
          ))}

          <View
            style={[
              s.food,
              { left: food[0] * CELL + 2, top: food[1] * CELL + 2,
                width: CELL - 4, height: CELL - 4 },
            ]}
          />

          {!running && !dead && (
            <View style={s.overlay}>
              <Text style={s.overlayTitle}>READY?</Text>
              <Text style={s.overlayDesc}>Tap arrows or swipe to start</Text>
              <TouchableOpacity style={s.playBtn} onPress={startGame}>
                <Text style={s.playBtnTxt}>▶  PLAY</Text>
              </TouchableOpacity>
            </View>
          )}
          {dead && (
            <View style={s.overlay}>
              <Text style={[s.overlayTitle, { color: COLORS.rose }]}>GAME OVER</Text>
              <Text style={s.overlayDesc}>Score: {score}</Text>
              <TouchableOpacity
                style={[s.playBtn, { borderColor: COLORS.rose }]}
                onPress={startGame}
              >
                <Text style={[s.playBtnTxt, { color: COLORS.rose }]}>↺  RETRY</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {/* D-pad — gesture recording is ALWAYS active regardless of game state */}
      <View style={s.controls}>
        <View style={s.dpad}>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => handleInput('up')}>
              <Text style={s.dpadTxt}>↑</Text>
            </TouchableOpacity>
          </View>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => handleInput('left')}>
              <Text style={s.dpadTxt}>←</Text>
            </TouchableOpacity>
            <View style={s.dpadCenter} />
            <TouchableOpacity style={s.dpadBtn} onPress={() => handleInput('right')}>
              <Text style={s.dpadTxt}>→</Text>
            </TouchableOpacity>
          </View>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => handleInput('down')}>
              <Text style={s.dpadTxt}>↓</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: SPACING.lg,
    paddingTop: 52,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
  },
  scoreBox: { width: 80 },
  scoreLabel: {
    fontFamily: FONTS.mono,
    color: COLORS.textMuted,
    fontSize: 10,
    letterSpacing: 2,
  },
  scoreVal: {
    fontFamily: FONTS.mono,
    color: COLORS.green,
    fontSize: 20,
    letterSpacing: 2,
  },
  titleTxt: {
    fontFamily: FONTS.headingX,
    color: COLORS.textPrimary,
    fontSize: 22,
    letterSpacing: 4,
  },
  levelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xs,
    alignSelf: 'flex-start',
    gap: 8,
  },
  levelTxt: {
    fontFamily: FONTS.mono,
    color: COLORS.textMuted,
    fontSize: 11,
    letterSpacing: 1,
  },
  levelDots: { flexDirection: 'row', gap: 3 },
  lvlDot: {
    width: 5, height: 5, borderRadius: 3,
    backgroundColor: COLORS.violet,
  },
  boardWrap: {
    padding: SPACING.xs,
    marginTop: SPACING.xs,
  },
  board: {
    backgroundColor: COLORS.surface1,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
    position: 'relative',
  },
  gridH: {
    position: 'absolute',
    left: 0, right: 0,
    height: 1,
    backgroundColor: COLORS.gridLine,
  },
  gridV: {
    position: 'absolute',
    top: 0, bottom: 0,
    width: 1,
    backgroundColor: COLORS.gridLine,
  },
  seg: { position: 'absolute' },
  eye: {
    position: 'absolute',
    width: 3, height: 3,
    borderRadius: 2,
    backgroundColor: COLORS.snakeEye,
  },
  eyeL: { top: 3, left: 3 },
  eyeR: { top: 3, right: 3 },
  food: {
    position: 'absolute',
    backgroundColor: COLORS.food,
    borderRadius: 4,
    shadowColor: COLORS.food,
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 4,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,10,15,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  overlayTitle: {
    fontFamily: FONTS.headingX,
    color: COLORS.green,
    fontSize: 32,
    letterSpacing: 4,
  },
  overlayDesc: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  playBtn: {
    marginTop: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.green,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.sm,
  },
  playBtnTxt: {
    fontFamily: FONTS.heading,
    color: COLORS.green,
    fontSize: 15,
    letterSpacing: 2,
  },
  controls: {
    paddingTop: SPACING.md,
    alignItems: 'center',
  },
  dpad: { gap: 3 },
  dpadRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 3,
  },
  dpadBtn: {
    width: 56, height: 56,
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dpadCenter: { width: 56, height: 56 },
  dpadTxt: {
    fontFamily: FONTS.mono,
    color: COLORS.textPrimary,
    fontSize: 22,
  },
});
