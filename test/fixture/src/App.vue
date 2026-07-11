<script setup lang="ts">
import Widget from './Widget.vue'

const items = [
  { count: 1, label: 'one' },
  { count: 2, label: 'two' },
]
</script>

<template>
    <!-- exercises component-in-template prop type-checking (the hard parity path) -->
    <Widget v-for="(it, i) in items" :key="i" :count="it.count" :label="it.label" />
</template>
