import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles.css'
import { installGlobalNoiseFilter } from './telemetry/noiseFilter'

const app = createApp(App)
installGlobalNoiseFilter()
app.use(createPinia())
app.use(router)
app.mount('#app')
