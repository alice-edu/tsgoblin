<script setup lang="ts">
const props = defineProps<{ count: number }>()
const doubled = props.count * 2
</script>

<template>
  <span class="badge">{{ doubled }}</span>
</template>
