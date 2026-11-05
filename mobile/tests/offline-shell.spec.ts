import {test,expect} from '@playwright/test';
test('a versão de produção reabre offline após primeiro acesso',async({browser})=>{
  const context=await browser.newContext({serviceWorkers:'allow',viewport:{width:390,height:844}});const page=await context.newPage();
  await page.goto('http://localhost:4173');
  await expect(page.getByText('Conectado',{exact:true})).toBeVisible();
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
  await context.setOffline(true);await page.reload();
  await expect(page.getByRole('heading',{name:'De olho na cidade.'})).toBeVisible();
  await expect(page.getByText('Sem conexão',{exact:true})).toBeVisible({timeout:20000});
  await expect(page.locator('.report-card').first()).toBeVisible();
  await context.close();
});
