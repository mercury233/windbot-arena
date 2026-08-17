import { createApp, h, ref, watch } from 'vue';
import {
    NConfigProvider,
    NMessageProvider,
    darkTheme,
    dateZhCN,
    zhCN,
} from 'naive-ui';
import App from './App.vue';
import './styles.css';

const componentThemeOverrides = {
    Button: {
        borderRadiusMedium: '10px',
        heightMedium: '40px',
    },
    Card: {
        borderRadius: '16px',
    },
    Input: {
        borderRadius: '10px',
    },
};

const darkThemeOverrides = {
    ...componentThemeOverrides,
    common: {
        bodyColor: '#071015',
        cardColor: '#0d191f',
        primaryColor: '#63e6d3',
        primaryColorHover: '#89f0e0',
        primaryColorPressed: '#40c8b5',
        successColor: '#70e29a',
        warningColor: '#f2c56d',
        errorColor: '#ff7b7b',
        borderColor: '#21343d',
        textColorBase: '#e7f0f3',
    },
};

const lightThemeOverrides = {
    ...componentThemeOverrides,
    common: {
        bodyColor: '#f2f7f7',
        cardColor: '#ffffff',
        primaryColor: '#137f73',
        primaryColorHover: '#0f9586',
        primaryColorPressed: '#0b6c63',
        successColor: '#218950',
        warningColor: '#ad7316',
        errorColor: '#c94747',
        borderColor: '#cbdadc',
        textColorBase: '#102a32',
        textColor1: '#102a32',
        textColor2: '#29464f',
        textColor3: '#4d666e',
        placeholderColor: '#6b8187',
    },
};

let initialDarkMode = false;
try {
    initialDarkMode = localStorage.getItem('windbot-arena-theme') === 'dark';
} catch {
    // 浏览器禁止本地存储时仍可在当前页面切换主题。
}

createApp({
    setup() {
        const darkMode = ref(initialDarkMode);
        watch(darkMode, (enabled) => {
            const theme = enabled ? 'dark' : 'light';
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.colorScheme = theme;
            document.querySelector('meta[name="theme-color"]')
                ?.setAttribute('content', enabled ? '#071015' : '#eef4f4');
            try {
                localStorage.setItem('windbot-arena-theme', theme);
            } catch {
                // 主题切换本身不依赖本地存储。
            }
        }, { immediate: true });

        return () => h(NConfigProvider, {
            dateLocale: dateZhCN,
            locale: zhCN,
            theme: darkMode.value ? darkTheme : null,
            themeOverrides: darkMode.value ? darkThemeOverrides : lightThemeOverrides,
        }, {
            default: () => h(NMessageProvider, { placement: 'top-right' }, {
                default: () => h(App, {
                    darkMode: darkMode.value,
                    'onUpdate:darkMode': (enabled) => { darkMode.value = enabled; },
                }),
            }),
        });
    },
}).mount('#app');
