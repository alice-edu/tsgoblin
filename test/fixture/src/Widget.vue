<script setup lang="ts">
const props = defineProps<{ count: number; label: string }>()
const doubled = props.count * 2
</script>

<template>
    <div class="widget" :data-slot="label">{{ doubled }} — {{ label }}</div>
</template>
