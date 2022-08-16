import * as React from 'react';
import type { ValidateMessages, FormInstance, FieldData, Store } from './interface';

export type Forms = Record<string, FormInstance>;

/**
 * form 中改变的 相关 field 信息
 */
export interface FormChangeInfo {
  changedFields: FieldData[];
  forms: Forms;
}

export interface FormFinishInfo {
  values: Store;
  forms: Forms;
}

export interface FormProviderProps {
  validateMessages?: ValidateMessages;
  onFormChange?: (name: string, info: FormChangeInfo) => void;
  onFormFinish?: (name: string, info: FormFinishInfo) => void;
  children?: React.ReactNode;
}

/**
 * 上下文相关回调：name => value 一一对应
 */
export interface FormContextProps extends FormProviderProps {
  triggerFormChange: (name: string, changedFields: FieldData[]) => void;
  triggerFormFinish: (name: string, values: Store) => void;
  registerForm: (name: string, form: FormInstance) => void;
  unregisterForm: (name: string) => void;
}

const FormContext = React.createContext<FormContextProps>({
  triggerFormChange: () => {},
  triggerFormFinish: () => {},
  registerForm: () => {},
  unregisterForm: () => {},
});

/**
 * 用作外层表单联动，带有 name 子表单的触发时它就会触发
 * @param param0
 * @returns
 */
const FormProvider: React.FunctionComponent<FormProviderProps> = ({
  validateMessages,
  onFormChange,
  onFormFinish,
  children,
}) => {
  // 拿父级的 Provider，回调会进行透传
  const formContext = React.useContext(FormContext);

  const formsRef = React.useRef<Forms>({});

  return (
    <FormContext.Provider
      value={{
        ...formContext,
        validateMessages: {
          ...formContext.validateMessages,
          ...validateMessages,
        },

        // =========================================================
        // =                  Global Form Control                  =
        // =========================================================
        triggerFormChange: (name, changedFields) => {
          // 此 name 是 Form 表单的 name
          if (onFormChange) {
            onFormChange(name, {
              changedFields,
              forms: formsRef.current,
            });
          }

          formContext.triggerFormChange(name, changedFields);
        },
        // 触发 Form 的 Finish 事件
        triggerFormFinish: (name, values) => {
          if (onFormFinish) {
            onFormFinish(name, {
              values,
              forms: formsRef.current,
            });
          }

          formContext.triggerFormFinish(name, values);
        },
        registerForm: (name, form) => {
          // 同步注册所有的 Form
          if (name) {
            formsRef.current = {
              ...formsRef.current,
              [name]: form,
            };
          }

          formContext.registerForm(name, form);
        },
        // 同步取消注册 Form
        unregisterForm: name => {
          const newForms = { ...formsRef.current };
          delete newForms[name];
          formsRef.current = newForms;

          formContext.unregisterForm(name);
        },
      }}
    >
      {children}
    </FormContext.Provider>
  );
};

export { FormProvider };

export default FormContext;
