import { registerWebModule, NativeModule } from 'expo';

class SecureShareIntakeModule extends NativeModule<{}> {
  async getPendingAsync() { return null; }
  async captureCleanupTokensAsync() { return []; }
  async discardAsync() { return true; }
}

export default registerWebModule(SecureShareIntakeModule, 'SecureShareIntake');
