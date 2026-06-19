import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList } from 'react-native';
import { Sheet } from './Sheet';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

export function GroupPicker({ visible, onClose, groups, count, onPick, onCreateNew }) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm }}>
        <Text style={s.title}>Add to group</Text>
        <Text style={s.subtitle}>
          {count} photo{count !== 1 ? 's' : ''} will be encrypted with that group's passphrase
        </Text>

        {groups.length > 0 && (
          <FlatList
            data={groups}
            keyExtractor={g => g.id}
            style={{ maxHeight: 240, marginBottom: SPACING.sm }}
            renderItem={({ item }) => (
              <TouchableOpacity style={s.row} onPress={() => onPick(item)}>
                <View style={[s.dot, { backgroundColor: item.color || COLORS.indigo }]} />
                <Text style={s.rowTxt}>{item.label}</Text>
                <Text style={s.rowArrow}>→</Text>
              </TouchableOpacity>
            )}
          />
        )}

        <TouchableOpacity style={s.btn} onPress={onCreateNew}>
          <Text style={s.btnTxt}>+ New Group</Text>
        </TouchableOpacity>
      </View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  title: { fontFamily: FONTS.heading, color: COLORS.textPrimary, fontSize: 18, marginBottom: 4 },
  subtitle: { fontFamily: FONTS.body, color: COLORS.textSecondary, fontSize: 13, marginBottom: SPACING.md },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: COLORS.surface3, borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: SPACING.md, paddingVertical: 14, marginBottom: 8,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowTxt: { flex: 1, fontFamily: FONTS.bodyMed, color: COLORS.textPrimary, fontSize: 14 },
  rowArrow: { color: COLORS.textMuted, fontSize: 14 },
  btn: { backgroundColor: COLORS.indigo, borderRadius: RADIUS.md, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  btnTxt: { fontFamily: FONTS.heading, color: '#fff', fontSize: 15 },
});
