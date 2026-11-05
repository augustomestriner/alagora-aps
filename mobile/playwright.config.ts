import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',timeout:90000,fullyParallel:false,workers:1,reporter:'list',use:{baseURL:'http://localhost:5173',launchOptions:{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'},headless:true,trace:'retain-on-failure'},outputDir:'test-results'});
