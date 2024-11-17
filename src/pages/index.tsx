import { memo, useEffect, useState } from 'react';

import Data from '@/components/Render';
import { ResponseData } from '@/type';
import { fetchClothes } from '@/services/clothes';

const Render = memo(() => {
  const [data, setData] = useState<ResponseData>();

  useEffect(() => {

    fetchClothes({
      gender: 'man',
      mood: 'happy',
    }).then((data) => {
      setData(data);
    });

    /* lobeChat.getPluginMessage().then((e: ResponseData) => {
      console.log('plugin====', e);
      setData(e);
    }); */
  }, []);

  return <Data {...data}></Data>;
});

export default Render;
